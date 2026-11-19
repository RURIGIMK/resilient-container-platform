# Capstone Project 6 · Resilient Container Platform & CI/CD

A small e-commerce backend ("Resilient Shop") on **Amazon ECS Fargate**, built to keep running when an Availability Zone fails, to absorb traffic spikes, and to deploy itself whenever code is merged to `main`. Everything is defined in CloudFormation in [`infrastructure/`](infrastructure/).

| Requirement | How it is met | Where |
|---|---|---|
| HA compute across ≥ 2 AZs | ECS Fargate services spread over 2 AZs behind an internet-facing ALB in both AZs | `01-core.yaml`, `02-services.yaml` |
| Resilient database | RDS PostgreSQL with **Multi-AZ** (synchronous standby), credentials managed by Secrets Manager | `01-core.yaml` |
| Caching | ElastiCache Redis replication group (primary + replica, Multi-AZ, automatic failover). The web app does cache-aside reads | `01-core.yaml`, `app/web/cache.js` |
| Asynchronous decoupling | `POST /orders` writes to RDS and enqueues to **SQS**. A separate worker service long-polls and processes. Failed messages go to a DLQ after 5 tries | `app/web/server.js`, `app/worker/worker.js` |
| Queue-driven scaling | Target tracking on **SQS backlog per running task** (metric math) for the worker; CPU and ALB requests per target for the web service | `02-services.yaml` |
| Automated backups | AWS Backup plan defined in IaC: daily RDS snapshot at 03:00 UTC, 7-day retention, in its own vault | `01-core.yaml` |
| DNS failover | Route 53 HTTP health check on the ALB, PRIMARY alias record to the ALB, SECONDARY to an S3 static maintenance page | `03-dr.yaml`, `infrastructure/failover-site/` |
| Serverless CI/CD | CodePipeline → CodeBuild (tests, builds **both** images, pushes to ECR) → ECS rolling deploy of both services, triggered automatically by commits to `main` | `04-pipeline.yaml`, `pipeline/buildspec.yml` |

---

## 1. Architecture

EVIDENCE_ARCHITECTURE

### Design decisions

- **No NAT gateway.** Fargate tasks run in the public subnets with public IPs. Their security group only accepts traffic from the ALB security group, so nothing on the internet can reach them directly. This removes the per-AZ NAT gateway, which would otherwise be either a single point of failure (one NAT) or the most expensive item in the bill (two NATs). RDS and Redis stay in private subnets with no route to the internet at all.
- **Liveness is separate from readiness.** `/health` only says "this container can serve". It deliberately does not check the database. If it did, a 30-second RDS failover would make every task fail its ALB health check at once, ECS would kill them all, and Route 53 would fail traffic over to the maintenance page for something the database recovers from on its own. `/status` reports the state of each dependency for operators.
- **The cache is never a dependency.** Every Redis call is wrapped so that if it fails, the read goes straight to RDS. If ElastiCache is lost, requests get slower but keep working.
- **Workers scale on backlog per task, not raw queue depth.** Queue depth alone doesn't fall when tasks are added, so target tracking on it keeps adding tasks. The policy uses metric math: `ApproximateNumberOfMessagesVisible ÷ RunningTaskCount` (Container Insights), with a target of 20 messages per task. That works out to about 20 s of acceptable lag at ~1 s per order.
- **Safe rolling deploys.** Both services run with `minimumHealthyPercent: 100`, `maximumPercent: 200` and the ECS **deployment circuit breaker with automatic rollback**. A bad image never reduces capacity and gets reverted automatically.
- **Workers shut down gracefully.** On SIGTERM (scale-in or deploy), the worker finishes the batch it is processing and then exits. Anything still unprocessed becomes visible on the queue again once the 120 s visibility timeout expires, so no order is lost.

### CI/CD without connecting GitHub to AWS

The brief says to connect CodePipeline to GitHub. The usual way is a CodeConnections (CodeStar) app installation, which gives AWS standing OAuth access to the GitHub account, or a GitHub Actions workflow holding AWS keys. I chose neither, so **no credential crosses between the two platforms**:

1. An EventBridge schedule runs a small CodeBuild project, `shop-source-poller`, every 5 minutes.
2. The poller runs `git ls-remote` against the **public** repo anonymously, the same way any visitor can, and compares the `main` SHA with the last one it handed off (stored in SSM Parameter Store).
3. If `main` has moved, it shallow-clones the repo, stamps `COMMIT_SHA`, and uploads `source/source.zip` to the versioned artifact bucket.
4. The S3 `Object Created` event starts **CodePipeline**: Source (S3) → Build (CodeBuild) → Deploy (ECS, web and worker in parallel).

The trade-off is up to 5 minutes before a merge triggers a deploy, in exchange for no OAuth grant and no long-lived keys to rotate or leak. Moving to CodeConnections later only means swapping the Source action.

---

## 2. CI/CD proof

EVIDENCE_CICD

---

## 3. Scaling proof

EVIDENCE_SCALING

---

## 4. Disaster recovery

### 4.1 Backup plan

EVIDENCE_BACKUP

### 4.2 Failover test

EVIDENCE_FAILOVER

### 4.3 DR runbook

RUNBOOK

---

## 5. Repository layout

```
app/
  web/        Express API: products (Redis cache-aside over RDS), orders → SQS, /health, /status, /load
  worker/     SQS long-poll consumer that processes orders and updates RDS
pipeline/
  buildspec.yml        CodeBuild: test, build + push web and worker images, emit imagedefinitions
infrastructure/
  01-core.yaml         VPC, ALB, ECS cluster, ECR, RDS Multi-AZ, ElastiCache, SQS + DLQ, AWS Backup
  02-services.yaml     Fargate task definitions, services, auto scaling policies, IAM task roles
  03-dr.yaml           Route 53 hosted zone, health check, failover records, S3 maintenance site
  04-pipeline.yaml     Source poller, CodeBuild, CodePipeline, EventBridge triggers
  deploy.sh            Ordered deploy / teardown helper
  failover-site/       Static maintenance page
docs/                  Diagram and evidence screenshots
```

## 6. Deploying it yourself

From AWS CloudShell in the target region:

```bash
git clone https://github.com/RURIGIMK/resilient-container-platform.git && cd resilient-container-platform
./infrastructure/deploy.sh core       # ~15 min, mostly RDS Multi-AZ + ElastiCache
./infrastructure/deploy.sh services   # services created at 0 tasks: no image exists yet
./infrastructure/deploy.sh pipeline   # starts the poller → first pipeline run builds + pushes images
./infrastructure/deploy.sh scale-up   # after the first green run: web 2 tasks, worker 1
./infrastructure/deploy.sh dr         # Route 53 failover + S3 maintenance page
./infrastructure/deploy.sh destroy    # tear down in reverse order (RDS keeps a final snapshot)
```
