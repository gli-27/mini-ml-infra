#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsStack } from '../lib/ecs-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

/**
 * CDK App — infrastructure for the mini-ml-agent platform.
 *
 * Stack dependency chain:
 *   VpcStack ─────┐
 *                  ├──▶ EcsStack ──▶ MonitoringStack
 *   EcrStack ─────┘
 *
 * Deploy: `cdk deploy --all --require-approval broadening`
 */
const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
};

// Shared networking
const vpcStack = new VpcStack(app, 'MiniLlm-Vpc', { env });

// Container registries
const ecrStack = new EcrStack(app, 'MiniLlm-Ecr', { env });

// LLM Serving — ECS Fargate + ALB
const ecsStack = new EcsStack(app, 'MiniLlm-Ecs', {
  env,
  vpc: vpcStack.vpc,
  repository: ecrStack.llmServingRepo,
});

// Monitoring — CloudWatch dashboards + alarms
const monitoringStack = new MonitoringStack(app, 'MiniLlm-Monitoring', {
  env,
  service: ecsStack.service,
  alb: ecsStack.alb,
});

// Explicit dependency declarations
ecsStack.addDependency(vpcStack);
ecsStack.addDependency(ecrStack);
monitoringStack.addDependency(ecsStack);
