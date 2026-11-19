#!/usr/bin/env bash
# Evidence helpers used for the README proofs. Run from CloudShell in the repo root.
#   smoke          hit the ALB: health, products (twice: database then cache), place an order
#   load [N]       enqueue N synthetic orders (default 3000) to drive worker scale-out
#   watch          print queue depth and worker task counts every 30 s
#   backup-now     start an on-demand AWS Backup job for the RDS instance (same vault/role as the plan)
#   dns            ask Route 53 what it currently answers for the failover record
#   fail           simulate a cluster outage: scale the web service to 0 tasks
#   recover        restore the web service to 2 tasks
set -euo pipefail
P=${PROJECT:-shop}
REGION=${AWS_REGION:-us-west-2}
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
  --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
ALB=$(out "$P-core" LoadBalancerDNS)

case "${1:-}" in
  smoke)
    curl -s "http://$ALB/health"; echo
    curl -s "http://$ALB/products" | head -c 200; echo
    curl -s "http://$ALB/products" | head -c 200; echo
    ORDER=$(curl -s -X POST -H 'content-type: application/json' -d '{"productId":2,"quantity":1}' "http://$ALB/orders")
    echo "$ORDER"; ID=$(echo "$ORDER" | sed -E 's/.*"orderId":"([^"]+)".*/\1/')
    sleep 8; curl -s "http://$ALB/orders/$ID"; echo ;;
  load)
    N=${2:-3000}
    for i in $(seq 1 $((N / 500))); do curl -s -X POST "http://$ALB/load?count=500"; echo; done ;;
  watch)
    Q=$(out "$P-core" QueueUrl)
    while true; do
      D=$(aws sqs get-queue-attributes --queue-url "$Q" --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text)
      W=$(aws ecs describe-services --cluster "$P-cluster" --services "$P-worker" --query 'services[0].[desiredCount,runningCount]' --output text)
      echo "$(date -u +%H:%M:%S) queue=$D worker desired/running=$W"; sleep 30
    done ;;
  backup-now)
    DB_ARN=$(aws rds describe-db-instances --db-instance-identifier "$P-db" --query 'DBInstances[0].DBInstanceArn' --output text)
    aws backup start-backup-job --backup-vault-name "$(out "$P-core" BackupVaultName)" \
      --resource-arn "$DB_ARN" --iam-role-arn "$(out "$P-core" BackupRoleArn)" --query BackupJobId --output text ;;
  dns)
    aws route53 test-dns-answer --hosted-zone-id "$(out "$P-dr" HostedZoneId)" \
      --record-name "$(out "$P-dr" RecordName)" --record-type A --query '[RecordName,RecordData]' --output text
    aws route53 get-health-check-status --health-check-id "$(out "$P-dr" HealthCheckId)" \
      --query 'HealthCheckObservations[0:3].[Region,StatusReport.Status]' --output text ;;
  fail)
    aws application-autoscaling register-scalable-target --service-namespace ecs \
      --resource-id "service/$P-cluster/$P-web" --scalable-dimension ecs:service:DesiredCount --min-capacity 0 --max-capacity 0
    aws ecs update-service --cluster "$P-cluster" --service "$P-web" --desired-count 0 --query 'service.desiredCount' ;;
  recover)
    aws application-autoscaling register-scalable-target --service-namespace ecs \
      --resource-id "service/$P-cluster/$P-web" --scalable-dimension ecs:service:DesiredCount --min-capacity 2 --max-capacity 6
    aws ecs update-service --cluster "$P-cluster" --service "$P-web" --desired-count 2 --query 'service.desiredCount' ;;
  *) echo "usage: $0 smoke|load [N]|watch|backup-now|dns|fail|recover"; exit 1 ;;
esac
