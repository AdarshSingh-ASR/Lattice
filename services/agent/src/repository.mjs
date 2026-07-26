import { randomUUID } from "node:crypto";
import { getPool, toVector, withSerializableRetry } from "./database.mjs";
import { stableHash } from "./guardrails.mjs";

export async function health() {
  const started = Date.now();
  const result = await getPool().query(
    "SELECT version() AS version, current_database() AS database, now() AS now",
  );
  return {
    ok: true,
    latencyMs: Date.now() - started,
    database: result.rows[0].database,
    version: result.rows[0].version,
    now: result.rows[0].now,
  };
}

export async function getIncident(workspaceId, incidentId) {
  const result = await getPool().query(
    `SELECT id, title, severity, region, status, summary, created_at
       FROM incidents
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, incidentId],
  );
  return result.rows[0] ?? null;
}

export async function retrieveMemories(workspaceId, embedding, limit = 5) {
  const result = await getPool().query(
    `SELECT id, kind, title, content, trust_score, provenance, signature_status,
            status, supersedes_id,
            1 - (embedding <=> $2::VECTOR) AS similarity
       FROM memories
      WHERE workspace_id = $1
        AND status IN ('active', 'superseded')
      ORDER BY embedding <=> $2::VECTOR
      LIMIT $3`,
    [workspaceId, toVector(embedding), limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    trustScore: Number(row.trust_score),
    provenance: row.provenance,
    signatureStatus: row.signature_status,
    status: row.status,
    supersedesId: row.supersedes_id,
    similarity: Number(row.similarity),
  }));
}

export async function createTraceRun({
  workspaceId,
  incidentId,
  idempotencyKey,
  retrieved,
  plan,
  conflicts,
  skillReceipts,
}) {
  return withSerializableRetry(async (client) => {
    const existing = await client.query(
      `SELECT id, phase, branch_name, plan, conflict_count, created_at
         FROM agent_runs
        WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    if (existing.rowCount) {
      return { ...existing.rows[0], replayed: true };
    }

    const runId = randomUUID();
    await client.query(
      `INSERT INTO agent_runs
        (workspace_id, id, incident_id, phase, branch_name, plan, conflict_count,
         idempotency_key, skill_receipts)
       VALUES ($1, $2, $3, 'blocked', 'main', $4::JSONB, $5, $6, $7::JSONB)`,
      [
        workspaceId,
        runId,
        incidentId,
        JSON.stringify(plan),
        conflicts.length,
        idempotencyKey,
        JSON.stringify(skillReceipts),
      ],
    );

    for (let index = 0; index < retrieved.length; index += 1) {
      const memory = retrieved[index];
      await client.query(
        `INSERT INTO memory_reads
          (workspace_id, run_id, memory_id, rank, similarity, decision, guardrail_result)
         VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)`,
        [
          workspaceId,
          runId,
          memory.id,
          index + 1,
          memory.similarity,
          memory.guardrail.safe ? "used" : "blocked",
          JSON.stringify(memory.guardrail),
        ],
      );
    }

    return {
      id: runId,
      phase: "blocked",
      branch_name: "main",
      plan,
      conflict_count: conflicts.length,
      replayed: false,
    };
  });
}

export async function quarantineAndBranch({
  workspaceId,
  runId,
  memoryId,
  reason,
  safePlan,
  idempotencyKey,
}) {
  return withSerializableRetry(async (client) => {
    const existing = await client.query(
      `SELECT state, result
         FROM action_journal
        WHERE workspace_id = $1 AND run_id = $2 AND action_key = $3`,
      [workspaceId, runId, idempotencyKey],
    );
    if (existing.rowCount) return { ...existing.rows[0].result, replayed: true };

    const journalId = randomUUID();
    const eventId = randomUUID();
    const inputHash = stableHash({ runId, memoryId, reason, safePlan });

    await client.query(
      `INSERT INTO action_journal
        (workspace_id, id, run_id, action_key, state, input_hash)
       VALUES ($1, $2, $3, $4, 'started', $5)`,
      [workspaceId, journalId, runId, idempotencyKey, inputHash],
    );

    const memory = await client.query(
      `SELECT id, title, content, provenance
         FROM memories
        WHERE workspace_id = $1 AND id = $2
        FOR UPDATE`,
      [workspaceId, memoryId],
    );

    if (!memory.rowCount) {
      throw new Error(`Memory ${memoryId} was not found in workspace ${workspaceId}.`);
    }

    await client.query(
      `INSERT INTO memory_events
        (workspace_id, id, memory_id, event_type, actor, reason, evidence_hash)
       VALUES ($1, $2, $3, 'quarantined', 'lattice-guardian', $4, $5)`,
      [workspaceId, eventId, memoryId, reason, stableHash(memory.rows[0])],
    );

    await client.query(
      `UPDATE agent_runs
          SET phase = 'verified', branch_name = $3, plan = $4::JSONB,
              resolved_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, runId, safePlan.branch, JSON.stringify(safePlan)],
    );

    const result = {
      runId,
      phase: "verified",
      branch: safePlan.branch,
      plan: safePlan,
      quarantinedMemoryId: memoryId,
      eventId,
      inputHash,
    };

    await client.query(
      `UPDATE action_journal
          SET state = 'completed', result = $4::JSONB, completed_at = now()
        WHERE workspace_id = $1 AND id = $2 AND run_id = $3`,
      [workspaceId, journalId, runId, JSON.stringify(result)],
    );

    return { ...result, replayed: false };
  });
}
