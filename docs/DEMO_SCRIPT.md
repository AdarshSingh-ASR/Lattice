# Lattice demo script — 2:30 target

## 0:00–0:18 — The problem

“Agents do not only hallucinate. They remember bad advice. During an incident,
one poisoned memory can quietly turn into a production action. Lattice is a
flight recorder and action gate for agent memory.”

Show the live **SEV-1 Checkout degradation** screen and point to the green
**Memory plane live** indicator.

## 0:18–0:48 — Live recall

Click **Run memory trace**.

“This is not a canned chat. Bedrock embeds the incident and CockroachDB searches
the distributed vector index. For each result, that same index measures
agreement with the nearest verified-memory cohort.”

Pause on the graph. Select `M-184`, `M-176`, then `M-211`.

## 0:48–1:15 — The reveal

When the red conflict card and branch graph appear:

“The most dangerous memory is also highly relevant. It says to disable JWT
signature verification. It is highly relevant but a 60-percent semantic
anomaly: unsigned, low-trust, and outside its verified cohort. The action
boundary executed nothing.”

Show **BLOCKED** and the immutable trace.

## 1:15–1:47 — Quarantine and replay

Click **Quarantine + replay**.

“The original decision stored an exact Cockroach HLC. Lattice now runs a real
AS OF SYSTEM TIME query to reconstruct all five rows exactly as they existed
when plan v1 was made. One serializable transaction quarantines M-211 on this
branch, blocks its dependent read, appends lineage, and commits plan v2.”

Point to:

- `replay / 0427-safe`
- unsafe actions `2 → 0`
- plan confidence `61 → 96`
- the visible `main` → `replay/0427-safe` branch divergence
- the orange human gate

Click **Approve safe plan**.

“Approval is a separate idempotent transaction. Lambda is now unlocked, but
Lattice still truthfully records that no production side effect was executed.”

## 1:47–2:12 — Why the database matters

Show the architecture diagram or the CockroachDB console.

“CockroachDB is not a log sink. Vector recall, cohort anomaly, historical
reconstruction, intervention lineage, branch state, and approval cannot drift
across databases.”

Mention:

- distributed vector index
- exact MVCC time travel with `AS OF SYSTEM TIME`
- serializable intervention and human-approval transactions
- CockroachDB Agent Skill receipts
- ccloud health automation

## 2:12–2:30 — Production proof

“Lambda is the typed execution boundary. Bedrock plans and embeds. S3 stores a
versioned, content-hashed evidence receipt. The runtime database user is
least-privilege, every side effect is gated, and every decision can be
reproduced from the exact memory snapshot that caused it.”

End on: **Lattice — memory that can prove itself.**
