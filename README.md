# 🏗️ Mini ML Infrastructure (CDK)

**AWS CDK (TypeScript) infrastructure for the mini-ml-agent platform — ECS Fargate, ALB, ECR, CloudWatch monitoring.**

```
┌──────────────────────────────────────────────────────────────────────┐
│                         VPC (2 AZs)                                   │
│                                                                       │
│  ┌─────────────────────┐         ┌─────────────────────────────────┐ │
│  │   Public Subnets     │         │       Private Subnets            │ │
│  │                      │         │                                  │ │
│  │  ┌──────────────┐   │   NAT   │  ┌────────────────────────────┐ │ │
│  │  │     ALB      │───┼────────▶│  │   ECS Fargate Cluster      │ │ │
│  │  │ (internet)   │   │         │  │                            │ │ │
│  │  │ idle=300s    │   │         │  │  ┌──────┐  ┌──────┐       │ │ │
│  │  └──────────────┘   │         │  │  │Task 1│  │Task 2│  (HA) │ │ │
│  │                      │         │  │  │4GB/2C│  │4GB/2C│       │ │ │
│  └─────────────────────┘         │  │  └──┬───┘  └──┬───┘       │ │ │
│                                   │  │     │         │            │ │ │
│                                   │  └─────┼─────────┼────────────┘ │ │
│                                   │        │         │              │ │
│                                   └────────┼─────────┼──────────────┘ │
│                                            │         │                │
└────────────────────────────────────────────┼─────────┼────────────────┘
                                             ▼         ▼
                                   ┌─────────────────────────┐
                                   │        ECR              │
                                   │  mini-llm-serving       │
                                   │  mini-agent-orchestrator│
                                   └─────────────────────────┘

                    ┌──────────────────────────────────────────┐
                    │         CloudWatch Monitoring             │
                    │  Dashboard: CPU, Memory, Latency, Errors │
                    │  Alarms → SNS → Email/Slack              │
                    └──────────────────────────────────────────┘
```

---

## Stacks

| Stack | Resources | Purpose |
|-------|-----------|---------|
| **MiniLlm-Vpc** | VPC, 2 AZs, public/private subnets, NAT Gateway, Flow Logs | Shared networking |
| **MiniLlm-Ecr** | 2 ECR repositories, lifecycle rules, scan-on-push | Container image registry |
| **MiniLlm-Ecs** | ECS Cluster, Fargate Service, ALB, Auto-Scaling | LLM Serving runtime |
| **MiniLlm-Monitoring** | CloudWatch Dashboard, 5 Alarms, SNS Topic | Observability |

### Stack Dependencies

```
MiniLlm-Vpc ────┐
                 ├──▶ MiniLlm-Ecs ──▶ MiniLlm-Monitoring
MiniLlm-Ecr ────┘
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **ALB idle timeout = 300s** | Default 60s kills long-running SSE streams. p99 generation time can exceed 60s. |
| **Health check startPeriod = 120s** | Model loading takes 30-90s depending on cache hit. Prevents premature task kills. |
| **minHealthyPercent = 100%** | Never go below desired capacity during rolling deploys. True zero-downtime. |
| **maxHealthyPercent = 200%** | Allow double tasks during transition. New tasks start before old drain. |
| **Circuit breaker + rollback** | Auto-rollback if >50% of new tasks fail health checks. No manual intervention. |
| **Asymmetric cooldowns** | Scale out fast (30s) for spikes, scale in slow (60s) to avoid flapping. |
| **Private subnets + NAT** | Fargate tasks not directly internet-accessible. Egress via NAT for ECR pulls. |
| **Container Insights** | Per-task CPU/memory metrics without custom instrumentation. |

---

## Deploy

### Prerequisites

- AWS CLI configured (`aws configure`)
- Node.js 18+
- Docker running
- CDK CLI (`npm install -g aws-cdk`)

### First-Time Setup

```bash
cd infra

# Install dependencies
npm install

# Bootstrap CDK (one-time per account/region)
npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2
```

### Deploy All Stacks

```bash
# Synthesize CloudFormation templates (validate)
npx cdk synth

# Deploy all stacks
npx cdk deploy --all --require-approval broadening
```

### Deploy Application Code

```bash
# Build + push Docker image + force ECS redeploy
./scripts/deploy.sh llm            # Deploy mini-llm-serving
./scripts/deploy.sh orchestrator   # Deploy mini-agent-orchestrator

# Or with blocking wait:
WAIT=true ./scripts/deploy.sh llm
```

### Verify

```bash
# Get ALB DNS name
ALB_DNS=$(aws elbv2 describe-load-balancers \
  --query 'LoadBalancers[0].DNSName' --output text)

curl http://$ALB_DNS/health
```

---

## Cost Estimate

Running 24/7 with 2 Fargate tasks (minimum HA configuration):

| Resource | Cost/Day | Cost/Month |
|----------|----------|------------|
| ECS Fargate (2 × 2vCPU × 4GB) | $4.80 | $144 |
| NAT Gateway | $1.08 | $32 |
| ALB | $0.67 | $20 |
| CloudWatch | $0.30 | $9 |
| **Total** | **~$6.85** | **~$205** |

### Cost-Saving for Demo/Development

```bash
# Scale to 0 when not demoing
aws ecs update-service --cluster MiniLlmCluster \
  --service LlmService --desired-count 0

# Scale back up
aws ecs update-service --cluster MiniLlmCluster \
  --service LlmService --desired-count 2
```

---

## Monitoring

### CloudWatch Alarms

| Alarm | Threshold | Action |
|-------|-----------|--------|
| High CPU | > 85% (2 of 3 periods) | SNS notification |
| High Memory | > 90% (2 periods) | SNS notification |
| ALB 5xx | > 10 (2 periods) | SNS notification |
| p99 Latency | > 10s (2 of 3 periods) | SNS notification |
| Unhealthy Tasks | < 2 tasks (2 periods) | SNS notification |

### Dashboard

Auto-generated CloudWatch dashboard: `mini-llm-serving`
- Row 1: ECS CPU, Memory, Running Tasks
- Row 2: ALB Requests, Response Time (p50/p99), HTTP Errors

---

## Companion Projects

| Repository | Description |
|------------|-------------|
| [gli-27/mini-llm-serving](https://github.com/gli-27/mini-llm-serving) | LLM inference server (192 tests) |
| [gli-27/mini-agent-orchestrator](https://github.com/gli-27/mini-agent-orchestrator) | Multi-agent workflow engine (109 tests) |
| [gli-27/mini-ml-infra](https://github.com/gli-27/mini-ml-infra) | This repo — AWS CDK infrastructure |

---

## Tech Stack

- **CDK**: TypeScript, aws-cdk-lib v2
- **Compute**: ECS Fargate (serverless containers)
- **Networking**: VPC, ALB, NAT Gateway
- **Registry**: ECR with lifecycle rules
- **Monitoring**: CloudWatch (dashboards, alarms, logs)
- **Notifications**: SNS
