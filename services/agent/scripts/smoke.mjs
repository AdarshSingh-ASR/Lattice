import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handler } from "../src/index.mjs";

const trace = await handler({
  rawPath: "/trace",
  requestContext: { http: { method: "POST" }, requestId: randomUUID() },
  headers: { "x-idempotency-key": `smoke-trace-${randomUUID()}` },
  body: JSON.stringify({ incidentId: "INC-0427" }),
});

assert.equal(trace.statusCode, 200, trace.body);
const traced = JSON.parse(trace.body);
assert.equal(traced.phase, "blocked");
assert.ok(traced.conflicts.some((memory) => memory.id === "M-211"));
assert.equal(traced.database.vectorIndex, "memory_embedding_idx");
assert.equal(traced.skillReceipts.length, 3);

const quarantine = await handler({
  rawPath: "/quarantine",
  requestContext: { http: { method: "POST" }, requestId: randomUUID() },
  headers: { "x-idempotency-key": `smoke-quarantine-${randomUUID()}` },
  body: JSON.stringify({
    runId: traced.runId,
    memoryId: "M-211",
    reason: "Unsigned memory conflicts with signed authentication policy P-07.",
  }),
});

assert.equal(quarantine.statusCode, 200, quarantine.body);
const resolved = JSON.parse(quarantine.body);
assert.equal(resolved.phase, "verified");
assert.equal(resolved.branch, "replay/0427-safe");
assert.equal(
  resolved.plan.actions.some((action) => /bypass/i.test(action.title)),
  false,
);

console.log(
  JSON.stringify({
    ok: true,
    runId: traced.runId,
    recalled: traced.memories.length,
    conflicts: traced.conflicts.map((memory) => memory.id),
    branch: resolved.branch,
    unsafeActions: 0,
    evidenceHash: resolved.evidence.hash,
  }),
);
