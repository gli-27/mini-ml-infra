import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * ECR Stack — container registries for both services.
 *
 * Lifecycle rules prevent unbounded image accumulation.
 * Interview: "I set maxImageCount to limit storage costs and use
 * immutable tags in CI to prevent accidental overwrites."
 */
export class EcrStack extends cdk.Stack {
  public readonly llmServingRepo: ecr.Repository;
  public readonly orchestratorRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // LLM Serving container repo
    this.llmServingRepo = new ecr.Repository(this, 'MiniLlmServingRepo', {
      repositoryName: 'mini-llm-serving',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });

    // Agent Orchestrator container repo
    this.orchestratorRepo = new ecr.Repository(this, 'MiniOrchestratorRepo', {
      repositoryName: 'mini-agent-orchestrator',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'LlmServingRepoUri', {
      value: this.llmServingRepo.repositoryUri,
    });
    new cdk.CfnOutput(this, 'OrchestratorRepoUri', {
      value: this.orchestratorRepo.repositoryUri,
    });
  }
}
