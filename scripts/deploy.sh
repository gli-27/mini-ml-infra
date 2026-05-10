#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# deploy.sh — Build and push Docker image to ECR, then force ECS redeploy
#
# Usage:
#   ./scripts/deploy.sh                    # Deploy mini-llm-serving
#   ./scripts/deploy.sh orchestrator       # Deploy mini-agent-orchestrator
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - Docker running
#   - CDK stacks already deployed (cdk deploy --all)
# ─────────────────────────────────────────────────────────────────────

SERVICE="${1:-llm}"
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

if [ "$SERVICE" = "llm" ] || [ "$SERVICE" = "mini-llm-serving" ]; then
  REPO_NAME="mini-llm-serving"
  DOCKER_CONTEXT="../mini-llm-serving"
  ECS_CLUSTER="MiniLlmCluster"
  ECS_SERVICE="LlmService"
elif [ "$SERVICE" = "orchestrator" ] || [ "$SERVICE" = "mini-agent-orchestrator" ]; then
  REPO_NAME="mini-agent-orchestrator"
  DOCKER_CONTEXT="../mini-agent-orchestrator"
  ECS_CLUSTER="MiniLlmCluster"
  ECS_SERVICE="OrchestratorService"
else
  echo "Unknown service: $SERVICE"
  echo "Usage: $0 [llm|orchestrator]"
  exit 1
fi

IMAGE_TAG="${REPO_NAME}:$(git -C ${DOCKER_CONTEXT} rev-parse --short HEAD)"
ECR_IMAGE="${ECR_REGISTRY}/${REPO_NAME}:latest"
ECR_IMAGE_TAGGED="${ECR_REGISTRY}/${IMAGE_TAG}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploying: ${REPO_NAME}"
echo "  Region:    ${REGION}"
echo "  Image:     ${ECR_IMAGE}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Authenticate Docker to ECR
echo "→ Authenticating Docker to ECR..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# 2. Build Docker image
echo "→ Building Docker image..."
docker build -t "${REPO_NAME}:latest" "${DOCKER_CONTEXT}"

# 3. Tag and push
echo "→ Tagging and pushing to ECR..."
docker tag "${REPO_NAME}:latest" "${ECR_IMAGE}"
docker tag "${REPO_NAME}:latest" "${ECR_IMAGE_TAGGED}"
docker push "${ECR_IMAGE}"
docker push "${ECR_IMAGE_TAGGED}"

# 4. Force new ECS deployment
echo "→ Forcing new ECS deployment..."
aws ecs update-service \
  --cluster "${ECS_CLUSTER}" \
  --service "${ECS_SERVICE}" \
  --force-new-deployment \
  --region "${REGION}" \
  --no-cli-pager

echo ""
echo "✅ Deploy initiated. Monitor:"
echo "   aws ecs describe-services --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE} --query 'services[0].deployments' --region ${REGION}"
echo ""

# 5. Wait for deployment (optional)
if [ "${WAIT:-false}" = "true" ]; then
  echo "→ Waiting for service stability..."
  aws ecs wait services-stable \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${REGION}"
  echo "✅ Service stable!"
fi
