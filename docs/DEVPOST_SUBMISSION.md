# Devpost submission copy

## Inspiration

Agents are moving from answering questions to changing production systems, but
their memory layer is usually treated as a bag of text chunks. A relevant
memory can still be stale, unsigned, poisoned, or superseded. Incident
response made the risk concrete: the wrong remembered workaround can become
an outage-amplifying action in seconds.

Lattice began with one question: **what if agent memory had a flight recorder,
branching, and an action gate?**

## What it does

Lattice is an incident-memory control plane. It retrieves semantically similar
operational memory, shows the causal path from each memory to the proposed
plan, and blocks side effects when recall fails provenance or policy checks.

If a memory is unsafe, Lattice can quarantine it and replay the same task on a
trusted memory branch. The operator sees the before/after plan, the exact
memory that changed it, required approvals, and an immutable evidence trail.

## How we built it

The product uses a Next.js control-room interface and a typed AWS Lambda agent
boundary. Amazon Bedrock Nova produces structured incident plans and Titan
creates 1024-dimensional embeddings. CockroachDB Cloud stores incidents,
versioned memories, embeddings, retrieval receipts, plans, quarantine events,
and idempotent action outcomes. Amazon S3 seals encrypted, versioned evidence
receipts.

## CockroachDB tools used

1. **Distributed Vector Indexing** — workspace-prefixed cosine search retrieves
   incident memories from a native `VECTOR(1024)` index.
2. **Agent Skills Repo** — exact snapshots of the transaction design,
   privilege hardening, and cluster health skills are loaded by the runtime.
   Their guardrails enter the planner context and their invocation receipts
   are persisted per agent run.
3. **ccloud CLI** — provisions separate SQL identities and generates a
   machine-readable cluster health assessment.

## AWS services used

- AWS Lambda and API Gateway for agent execution
- Amazon Bedrock Nova and Titan for planning and embeddings
- Amazon S3 for encrypted, versioned evidence receipts
- CockroachDB Cloud is deployed in AWS ap-south-1

## Challenges

The hard part was preserving a clean boundary between probabilistic planning
and authoritative action. Model calls and evidence uploads cannot live inside
a retried database transaction. We split the workflow into short serializable
state transitions, added an idempotency journal, and treated ambiguous outcomes
as unknown instead of retrying blindly.

The second challenge was making memory causality visible. A similarity score
alone is not enough. Lattice stores retrieval rank, provenance, trust,
guardrail decisions, plan versions, and branch state so a judge can see why
the action changed.

## Accomplishments

- A real distributed CockroachDB vector index, not a mocked retrieval layer
- Atomic quarantine + branch replay with serializable retry handling
- A least-privilege runtime SQL identity separated from migrations
- Skill receipts for three CockroachDB Agent Skills on every trace
- Complete interaction tested on desktop and mobile
- A one-click demo that turns a dangerous plan into a safe, reproducible branch

## What we learned

Agent memory should be judged less like chat history and more like production
configuration: versioned, attributable, scoped, and reversible. The most
important question is not “what did the agent remember?” but “which memory was
allowed to change the world?”

## What’s next

- Stream CloudWatch and OpenTelemetry incident evidence
- Add multi-region follower-read dashboards
- Support signed human corrections and memory merge reviews
- Add evaluation suites for memory poisoning, stale runbooks, and policy drift
- Generalize the action gate for deployment, support, and financial operations
