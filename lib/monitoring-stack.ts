import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface MonitoringStackProps extends cdk.StackProps {
  service: ecs.FargateService;
  alb: elbv2.ApplicationLoadBalancer;
}

/**
 * Monitoring Stack — CloudWatch dashboards + alarms for the LLM serving platform.
 *
 * Interview: "I created a dedicated monitoring stack so it can be deployed/updated
 * independently from the service stack — changing alarm thresholds doesn't
 * trigger a service redeployment."
 */
export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // SNS Topic for alarm notifications
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'mini-llm-alarms',
      displayName: 'Mini LLM Serving Alarms',
    });

    // ──────────────────────────────────────────────
    // CloudWatch Alarms
    // ──────────────────────────────────────────────

    // High CPU alarm → triggers scale-out investigation
    const cpuAlarm = new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      metric: props.service.metricCpuUtilization(),
      threshold: 85,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'ECS CPU > 85% for 2 of 3 periods — investigate scaling or model optimization',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cpuAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // High memory alarm → risk of OOM kills
    const memoryAlarm = new cloudwatch.Alarm(this, 'HighMemoryAlarm', {
      metric: props.service.metricMemoryUtilization(),
      threshold: 90,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'ECS Memory > 90% — risk of OOM, consider increasing task memory or reducing batch size',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    memoryAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // ALB 5xx errors → service errors
    const alb5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      metric: props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'ALB returning 5xx errors — check ECS task health and logs',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alb5xxAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // Target response time p99 > 10s
    const latencyAlarm = new cloudwatch.Alarm(this, 'HighLatencyAlarm', {
      metric: props.alb.metrics.targetResponseTime({
        statistic: 'p99',
      }),
      threshold: 10,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'p99 latency > 10s — check model performance, queue depth, or scaling',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    latencyAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // Healthy task count < 2 → HA degraded
    const healthyTaskAlarm = new cloudwatch.Alarm(this, 'UnhealthyTaskAlarm', {
      metric: props.service.metricCpuUtilization().with({
        statistic: 'SampleCount',
      }),
      threshold: 2,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'Fewer than 2 healthy tasks — HA degraded, check task failures',
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    healthyTaskAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // ──────────────────────────────────────────────
    // CloudWatch Dashboard
    // ──────────────────────────────────────────────

    const dashboard = new cloudwatch.Dashboard(this, 'LlmDashboard', {
      dashboardName: 'mini-llm-serving',
    });

    // Row 1: Service health
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS CPU Utilization',
        left: [props.service.metricCpuUtilization()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Memory Utilization',
        left: [props.service.metricMemoryUtilization()],
        width: 8,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Running Tasks',
        metrics: [props.service.metricCpuUtilization().with({
          statistic: 'SampleCount',
        })],
        width: 8,
      }),
    );

    // Row 2: ALB metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB Request Count',
        left: [props.alb.metrics.requestCount()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Target Response Time',
        left: [
          props.alb.metrics.targetResponseTime({ statistic: 'p50' }),
          props.alb.metrics.targetResponseTime({ statistic: 'p99' }),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB HTTP Errors',
        left: [
          props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT),
          props.alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT),
        ],
        width: 8,
      }),
    );

    // Outputs
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS topic for alarm notifications — subscribe email/Slack',
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=mini-llm-serving`,
      description: 'CloudWatch dashboard URL',
    });
  }
}
