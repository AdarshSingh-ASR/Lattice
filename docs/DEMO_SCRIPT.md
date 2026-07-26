# Lattice demo script — 2:30 target

## 0:00–0:18 — The problem

“Agents do not only hallucinate. They remember bad advice. During an incident,
one poisoned memory can quietly turn into a production action. Lattice is a
flight recorder and action gate for agent memory.”

Show the live **SEV-1 Checkout degradation** screen and point to the green
**Memory plane live** indicator.

## 0:18–0:48 — Live recall

Click **Run memory trace**.

“This is not a canned chat. Bedrock embeds the current incident and CockroachDB
searches the distributed vector index. The same database holds the incident,
memory provenance, policies, agent run, and action journal.”

Pause on the graph. Select `M-184`, `M-176`, then `M-211`.

## 0:48–1:15 — The reveal

When the red conflict card appears:

“The most dangerous memory is also highly relevant. It says to disable JWT
signature verification. Lattice catches three problems: it is unsigned,
low-trust, and conflicts with signed policy P-07. The model proposed an unsafe
step, but the action boundary executed nothing.”

Show **BLOCKED** and the immutable trace.

## 1:15–1:47 — Quarantine and replay

Click **Quarantine + replay**.

“One serializable CockroachDB transaction quarantines the memory, appends an
immutable event, creates a trusted branch, and journals the idempotency key.
Then the agent replays the same incident without the poisoned memory.”

Point to:

- `replay / 0427-safe`
- unsafe actions `2 → 0`
- plan confidence `61 → 96`
- human approval still required for credential work

## 1:47–2:12 — Why the database matters

Show the architecture diagram or the CockroachDB console.

“CockroachDB is not a log sink. It is both the vector memory and the
transactional system of record. Semantic recall, supersession, quarantine,
branch state, and idempotent action outcomes cannot drift across databases.”

Mention:

- distributed vector index
- CockroachDB Agent Skill receipts
- ccloud health automation

## 2:12–2:30 — Production proof

“Lambda is the typed execution boundary. Bedrock plans and embeds. S3 stores a
versioned, content-hashed evidence receipt. The runtime database user is
least-privilege, every side effect is gated, and every decision can be
reproduced from the exact memory snapshot that caused it.”

End on: **Lattice — memory that can prove itself.**
