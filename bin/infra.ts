#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsStack } from '../lib/ecs-stack';

/**
 * CDK App — infrastructure for the mini-ml-agent platform.
 *
 * Stack dependency chain:
 *   VpcStack → EcsStack
 *   EcrStack → EcsStack
 *
 * Deploy order: VPC + ECR first (no dependencies), then ECS.
 */
const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
};

// Shared networking
const vpcStack = new VpcStack(app, 'MiniMlVpcStack', { env });

// Container registries
const ecrStack = new EcrStack(app, 'MiniMlEcrStack', { env });

// LLM Serving — ECS Fargate + ALB
new EcsStack(app, 'MiniLlmEcsStack', {
  env,
  vpc: vpcStack.vpc,
  repository: ecrStack.llmServingRepo,
});
