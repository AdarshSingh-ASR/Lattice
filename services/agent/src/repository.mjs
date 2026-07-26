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
            status, supersedes_id, embedding::STRING AS embedding_literal,
            1 - (embedding <=> $2::VECTOR) AS similarity
       FROM memories
      WHERE workspace_id = $1
        AND status IN ('active', 'superseded')
      ORDER BY embedding <=> $2::VECTOR
      LIMIT $3`,
    [workspaceId, toVector(embedding), limit],
  );

  return Promise.all(
    result.rows.map(async (row) => {
      const cohort = await getPool().query(
        `SELECT COALESCE(avg(similarity), 0) AS agreement
           FROM (
             SELECT 1 - (embedding <=> $2::VECTOR) AS similarity
               FROM memories
              WHERE workspace_id = $1
                AND id != $3
                AND signature_status = 'verified'
                AND status IN ('active', 'superseded')
              ORDER BY embedding <=> $2::VECTOR
              LIMIT 3
           ) AS nearest_verified_cohort`,
        [workspaceId, row.embedding_literal, row.id],
      );
      const similarity = Number(row.similarity);
      const cohortAgreement = Number(cohort.rows[0].agreement);
      const semanticAnomaly = Math.min(
        1,
        Math.max(
          0,
          (1 - similarity) * 0.45 +
            (1 - cohortAgreement) * 0.35 +
            (1 - Number(row.trust_score) / 100) * 0.2,
        ),
      );

      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        trustScore: Number(row.trust_score),
        provenance: row.provenance,
        signatureStatus: row.signature_status,
        status: row.status,
        supersedesId: row.supersedes_id,
        similarity,
        cohortAgreement,
        semanticAnomaly,
      };
    }),
  );
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
      `SELECT id, phase, branch_name, plan, conflict_count, created_at,
              decision_hlc, decision_wall_time
         FROM agent_runs
        WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    if (existing.rowCount) {
      return { ...existing.rows[0], replayed: true };
    }

    const runId = randomUUID();
    const clock = await client.query(
      `SELECT cluster_logical_timestamp() AS hlc,
              statement_timestamp() AS wall_time`,
    );
    const decisionHlc = clock.rows[0].hlc;
    const decisionWallTime = clock.rows[0].wall_time;
    await client.query(
      `INSERT INTO agent_runs
        (workspace_id, id, incident_id, phase, branch_name, plan, conflict_count,
         idempotency_key, skill_receipts, decision_hlc, decision_wall_time)
       VALUES ($1, $2, $3, 'blocked', 'main', $4::JSONB, $5, $6, $7::JSONB,
               $8::DECIMAL, $9)`,
      [
        workspaceId,
        runId,
        incidentId,
        JSON.stringify(plan),
        conflicts.length,
        idempotencyKey,
        JSON.stringify(skillReceipts),
        decisionHlc,
        decisionWallTime,
      ],
    );

    for (let index = 0; index < retrieved.length; index += 1) {
      const memory = retrieved[index];
      await client.query(
        `INSERT INTO memory_reads
          (workspace_id, run_id, memory_id, rank, similarity, decision,
           guardrail_result, cohort_agreement, semantic_anomaly)
         VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8, $9)`,
        [
          workspaceId,
          runId,
          memory.id,
          index + 1,
          memory.similarity,
          memory.guardrail.safe ? "used" : "blocked",
          JSON.stringify(memory.guardrail),
          memory.cohortAgreement,
          memory.semanticAnomaly,
        ],
      );
    }

    return {
      id: runId,
      phase: "blocked",
      branch_name: "main",
      plan,
      conflict_count: conflicts.length,
      decision_hlc: decisionHlc,
      decision_wall_time: decisionWallTime,
      replayed: false,
    };
  });
}

export async function reconstructDecisionContext(workspaceId, runId) {
  const run = await getPool().query(
    `SELECT decision_hlc, decision_wall_time
       FROM agent_runs
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, runId],
  );
  if (!run.rowCount || !run.rows[0].decision_hlc) {
    throw new Error(`Run ${runId} has no historical decision timestamp.`);
  }

  const decisionHlc = String(run.rows[0].decision_hlc);
  if (!/^\d+(?:\.\d+)?$/.test(decisionHlc)) {
    throw new Error("Decision HLC was not a valid CockroachDB timestamp.");
  }

  const reads = await getPool().query(
    `SELECT memory_id, rank
       FROM memory_reads
      WHERE workspace_id = $1 AND run_id = $2
      ORDER BY rank`,
    [workspaceId, runId],
  );
  const ranks = new Map(reads.rows.map((row) => [row.memory_id, Number(row.rank)]));

  // CockroachDB does not support placeholders in AS OF SYSTEM TIME. The value
  // embedded here is validated above and was emitted by cluster_logical_timestamp().
  const historical = await getPool().query(
    `SELECT id, kind, title, content, trust_score, provenance, signature_status,
            status, supersedes_id, created_at
       FROM memories AS OF SYSTEM TIME ${decisionHlc}
      WHERE workspace_id = $1`,
    [workspaceId],
  );

  const memories = historical.rows
    .filter((row) => ranks.has(row.id))
    .sort((a, b) => ranks.get(a.id) - ranks.get(b.id))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      trustScore: Number(row.trust_score),
      provenance: row.provenance,
      signatureStatus: row.signature_status,
      status: row.status,
      supersedesId: row.supersedes_id,
      createdAt: row.created_at,
    }));

  return {
    decisionHlc,
    decisionWallTime: run.rows[0].decision_wall_time,
    memories,
    proof: {
      engine: "cockroachdb-mvcc",
      queryMode: "AS OF SYSTEM TIME",
      exactHlc: decisionHlc,
      reconstructedRows: memories.length,
    },
  };
}

export async function quarantineAndBranch({
  workspaceId,
  runId,
  memoryId,
  reason,
  safePlan,
  idempotencyKey,
  temporalProof,
  replayPlanner,
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
        (workspace_id, id, memory_id, event_type, actor, reason, evidence_hash,
         run_id, branch_name)
       VALUES ($1, $2, $3, 'quarantined', 'lattice-guardian', $4, $5, $6, $7)`,
      [
        workspaceId,
        eventId,
        memoryId,
        reason,
        stableHash(memory.rows[0]),
        runId,
        safePlan.branch,
      ],
    );

    await client.query(
      `INSERT INTO memory_interventions
        (workspace_id, run_id, memory_id, state, actor, reason, evidence_hash)
       VALUES ($1, $2, $3, 'quarantined', 'lattice-guardian', $4, $5)`,
      [workspaceId, runId, memoryId, reason, stableHash(memory.rows[0])],
    );

    await client.query(
      `UPDATE memory_reads
          SET decision = 'quarantined'
        WHERE workspace_id = $1 AND run_id = $2 AND memory_id = $3`,
      [workspaceId, runId, memoryId],
    );

    await client.query(
      `UPDATE agent_runs
          SET phase = 'approval_required', branch_name = $3, plan = $4::JSONB,
              resolved_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, runId, safePlan.branch, JSON.stringify(safePlan)],
    );

    const result = {
      runId,
      phase: "approval_required",
      branch: safePlan.branch,
      plan: safePlan,
      quarantinedMemoryId: memoryId,
      eventId,
      inputHash,
      temporalProof,
      replayPlanner,
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

export async function approveRun({
  workspaceId,
  runId,
  actor,
  idempotencyKey,
}) {
  return withSerializableRetry(async (client) => {
    const existing = await client.query(
      `SELECT result
         FROM action_journal
        WHERE workspace_id = $1 AND run_id = $2 AND action_key = $3
          AND state = 'completed'`,
      [workspaceId, runId, idempotencyKey],
    );
    if (existing.rowCount) return { ...existing.rows[0].result, replayed: true };

    const run = await client.query(
      `SELECT phase, branch_name, plan
         FROM agent_runs
        WHERE workspace_id = $1 AND id = $2
        FOR UPDATE`,
      [workspaceId, runId],
    );
    if (!run.rowCount || !["approval_required", "approved"].includes(run.rows[0].phase)) {
      throw new Error(`Run ${runId} is not ready for human approval.`);
    }

    const journalId = randomUUID();
    const planHash = stableHash(run.rows[0].plan);
    await client.query(
      `INSERT INTO action_journal
        (workspace_id, id, run_id, action_key, state, input_hash)
       VALUES ($1, $2, $3, $4, 'started', $5)`,
      [workspaceId, journalId, runId, idempotencyKey, planHash],
    );
    await client.query(
      `INSERT INTO human_approvals
        (workspace_id, run_id, decision, actor, plan_hash)
       VALUES ($1, $2, 'approved', $3, $4)
       ON CONFLICT (workspace_id, run_id) DO NOTHING`,
      [workspaceId, runId, actor, planHash],
    );
    await client.query(
      `UPDATE agent_runs
          SET phase = 'approved', approved_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, runId],
    );

    const result = {
      runId,
      phase: "approved",
      branch: run.rows[0].branch_name,
      actor,
      planHash,
      executionGate: "unlocked",
      sideEffectsExecuted: false,
    };
    await client.query(
      `UPDATE action_journal
          SET state = 'completed', result = $3::JSONB, completed_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, journalId, JSON.stringify(result)],
    );
    return { ...result, replayed: false };
  });
}
