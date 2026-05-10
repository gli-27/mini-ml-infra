import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  repository: ecr.Repository;
}

/**
 * ECS Stack — Fargate service for mini-llm-serving with ALB.
 *
 * Key design decisions:
 * - 4GB RAM / 2 vCPU for model loading headroom
 * - 120s health check start period (model download + GPU init)
 * - ALB idle timeout 300s (SSE streaming can exceed default 60s)
 * - Circuit breaker for automatic bad-deploy rollback
 * - Target tracking auto-scaling on CPU (70% target)
 * - Min 2 tasks across AZs for high availability
 */
export class EcsStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'MiniLlmCluster', {
      vpc: props.vpc,
      containerInsights: true,
      // Interview: "Container Insights gives me per-task CPU/memory metrics
      // without custom instrumentation — critical for capacity planning."
    });

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'LlmTaskDef', {
      memoryLimitMiB: 4096, // 4GB for model loading
      cpu: 2048,            // 2 vCPU
    });

    // Container
    const container = taskDef.addContainer('MiniLlmContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mini-llm',
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        LLM_MODEL_NAME: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0',
        LLM_MAX_CONCURRENT: '10',
        LLM_QUEUE_MAX_SIZE: '100',
        LLM_ENVIRONMENT: 'production',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
        // Interview: "Model loading takes 30-90s depending on cache hit.
        // 120s start period prevents premature task kills during cold start."
      },
    });

    container.addPortMappings({ containerPort: 8000 });

    // Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'LlmAlb', {
      vpc: props.vpc,
      internetFacing: true,
    });

    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      // In production: port 443 with ACM certificate
    });

    // Fargate Service
    this.service = new ecs.FargateService(this, 'LlmService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      // Interview: "Min 2 for HA across AZs — if one AZ goes down,
      // we still serve traffic from the other."
      assignPublicIp: false, // Private subnet + NAT
      circuitBreaker: { rollback: true },
      // Interview: "Circuit breaker auto-rolls back if new tasks fail health checks,
      // preventing bad deploys from taking down the service."
    });

    // Register with ALB
    listener.addTargets('EcsTarget', {
      port: 8000,
      targets: [this.service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
      // Interview: "30s deregistration delay lets in-flight requests complete
      // during rolling deploys without connection resets."
    });

    // ALB idle timeout for SSE streaming
    this.alb.setAttribute('idle_timeout.timeout_seconds', '300');
    // Interview: "I learned this the hard way — ALB has a 60s default idle timeout
    // that kills long-running SSE streams. You need to tune it based on your
    // p99 generation time. 300s covers even the longest completions."

    // Auto-Scaling
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
      // Interview: "Asymmetric cooldowns — scale out fast (30s) to handle spikes,
      // scale in slow (60s) to avoid flapping during bursty traffic."
    });

    scaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 50,
      targetGroup: listener.addTargets('ScalingTarget', {
        port: 8000,
        targets: [this.service],
      }),
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name for the LLM serving endpoint',
    });

    new cdk.CfnOutput(this, 'ServiceArn', {
      value: this.service.serviceArn,
    });
  }
}
