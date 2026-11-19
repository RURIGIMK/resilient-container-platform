#!/usr/bin/env bash
# One-shot deployment, run from AWS CloudShell (or any shell with AWS credentials):
#   git clone https://github.com/RURIGIMK/resilient-container-platform.git && cd resilient-container-platform
#   ./infrastructure/deploy.sh <step>
#
# Steps must run in order the first time, because the ECS services need an image in ECR
# before they can start, and the pipeline is what produces that image:
#   core      VPC, ALB, ECS cluster, ECR, RDS Multi-AZ, ElastiCache, SQS, AWS Backup  (~15 min)
#   services  ECS services with 0 tasks (no image yet) + auto scaling policies
#   pipeline  poller + CodePipeline; kicks the poller so the first build runs immediately
#   scale-up  once the pipeline is green: web min 2 / worker min 1
#   dr        Route 53 health check + failover records, S3 maintenance site
set -euo pipefail

P=${PROJECT:-shop}
REGION=${AWS_REGION:-$(aws configure get region || echo us-west-2)}
DIR="$(cd "$(dirname "$0")" && pwd)"
deploy() { aws cloudformation deploy --region "$REGION" --no-fail-on-empty-changeset \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --stack-name "$1" --template-file "$2" "${@:3}"; }

case "${1:-}" in
  core)
    deploy "$P-core" "$DIR/01-core.yaml" --parameter-overrides ProjectName="$P" ;;
  services)
    deploy "$P-services" "$DIR/02-services.yaml" --parameter-overrides ProjectName="$P" WebMinTasks=0 WorkerMinTasks=0 ;;
  pipeline)
    deploy "$P-pipeline" "$DIR/04-pipeline.yaml" --parameter-overrides ProjectName="$P"
    aws codebuild start-build --region "$REGION" --project-name "$P-source-poller" --query 'build.id' --output text ;;
  scale-up)
    deploy "$P-services" "$DIR/02-services.yaml" --parameter-overrides ProjectName="$P" WebMinTasks=2 WorkerMinTasks=1 ;;
  dr)
    deploy "$P-dr" "$DIR/03-dr.yaml" --parameter-overrides ProjectName="$P"
    BUCKET=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$P-dr" \
      --query "Stacks[0].Outputs[?OutputKey=='MaintenanceBucket'].OutputValue" --output text)
    aws s3 cp "$DIR/failover-site/index.html" "s3://$BUCKET/index.html" --content-type text/html ;;
  outputs)
    for s in core services pipeline dr; do
      aws cloudformation describe-stacks --region "$REGION" --stack-name "$P-$s" \
        --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text 2>/dev/null || true
    done ;;
  destroy)
    # Reverse order. RDS keeps a final snapshot (DeletionPolicy: Snapshot).
    for s in dr pipeline services core; do
      aws cloudformation delete-stack --region "$REGION" --stack-name "$P-$s"
      aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$P-$s" || true
    done ;;
  *)
    echo "usage: $0 core|services|pipeline|scale-up|dr|outputs|destroy"; exit 1 ;;
esac
