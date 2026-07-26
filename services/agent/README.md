# Lattice agent service

This AWS Lambda service is the execution boundary behind the Lattice demo.
It uses Amazon Bedrock for incident planning and Titan embeddings, CockroachDB
for transactional and semantic memory, and a versioned Amazon S3 bucket for
immutable evidence receipts.

## Local setup

```powershell
npm install
$env:DATABASE_URL = "postgresql://..."
$env:AWS_REGION = "us-east-1"
npm run migrate
npm run seed
npm test
```

## Deploy

```powershell
sam build
sam deploy --guided --parameter-overrides DatabaseUrl="$env:DATABASE_URL"
```

The Lambda role can invoke Bedrock and write evidence only to the generated
bucket. Database credentials are passed as a protected CloudFormation
parameter and never committed.

## CockroachDB Agent Skills

The runtime loads exact, attributed snapshots of
`designing-application-transactions`, `hardening-user-privileges`, and
`reviewing-cluster-health` from the open-source
`cockroachlabs/cockroachdb-skills` repository. It includes skill receipts with
every trace and injects their retry, transaction, idempotency, health, and
least-privilege guardrails into the planner context.
