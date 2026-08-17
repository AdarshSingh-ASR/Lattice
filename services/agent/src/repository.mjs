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
            status, supersedes_id, created_at, embedding::STRING AS embedding_literal,
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
        createdAt: row.created_at,
        similarity,
        cohortAgreement,
        semanticAnomaly,
      };
    }),
  );
}

/**
 * Returns the raw provenance rows CockroachDB holds for a single agent run.
 * Every array here is a direct table read; the UI renders these rows as the
 * memory timeline instead of keeping its own copy of the story.
 */
export async function getLineage(workspaceId, runId) {
  const pool = getPool();

  const run = await pool.query(
    `SELECT id, incident_id, phase, branch_name, plan, conflict_count,
            skill_receipts, decision_hlc, decision_wall_time,
            created_at, resolved_at, approved_at
       FROM agent_runs
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, runId],
  );
  if (!run.rowCount) return null;

  const [reads, events, interventions, approvals, journal] = await Promise.all([
    pool.query(
      `SELECT r.memory_id, r.rank, r.similarity, r.decision, r.guardrail_result,
              r.cohort_agreement, r.semantic_anomaly, r.created_at,
              m.title, m.kind, m.content, m.trust_score, m.signature_status,
              m.provenance, m.status, m.supersedes_id,
              m.created_at AS memory_created_at
         FROM memory_reads AS r
         JOIN memories AS m
           ON m.workspace_id = r.workspace_id AND m.id = r.memory_id
        WHERE r.workspace_id = $1 AND r.run_id = $2
        ORDER BY r.rank`,
      [workspaceId, runId],
    ),
    pool.query(
      `SELECT id, memory_id, event_type, actor, reason, evidence_hash,
              run_id, branch_name, created_at
         FROM memory_events
        WHERE workspace_id = $1
          AND memory_id IN (
            SELECT memory_id FROM memory_reads
             WHERE workspace_id = $1 AND run_id = $2
          )
        ORDER BY created_at`,
      [workspaceId, runId],
    ),
    pool.query(
      `SELECT memory_id, state, actor, reason, evidence_hash, created_at
         FROM memory_interventions
        WHERE workspace_id = $1 AND run_id = $2
        ORDER BY created_at`,
      [workspaceId, runId],
    ),
    pool.query(
      `SELECT decision, actor, plan_hash, created_at
         FROM human_approvals
        WHERE workspace_id = $1 AND run_id = $2`,
      [workspaceId, runId],
    ),
    pool.query(
      `SELECT action_key, state, input_hash, created_at, completed_at
         FROM action_journal
        WHERE workspace_id = $1 AND run_id = $2
        ORDER BY created_at`,
      [workspaceId, runId],
    ),
  ]);

  return {
    run: {
      id: run.rows[0].id,
      incidentId: run.rows[0].incident_id,
      phase: run.rows[0].phase,
      branch: run.rows[0].branch_name,
      plan: run.rows[0].plan,
      conflictCount: Number(run.rows[0].conflict_count),
      skillReceipts: run.rows[0].skill_receipts,
      decisionHlc: run.rows[0].decision_hlc,
      decisionWallTime: run.rows[0].decision_wall_time,
      createdAt: run.rows[0].created_at,
      resolvedAt: run.rows[0].resolved_at,
      approvedAt: run.rows[0].approved_at,
    },
    reads: reads.rows.map((row) => ({
      memoryId: row.memory_id,
      rank: Number(row.rank),
      similarity: Number(row.similarity),
      decision: row.decision,
      guardrail: row.guardrail_result,
      cohortAgreement: row.cohort_agreement === null ? null : Number(row.cohort_agreement),
      semanticAnomaly: row.semantic_anomaly === null ? null : Number(row.semantic_anomaly),
      readAt: row.created_at,
      title: row.title,
      kind: row.kind,
      content: row.content,
      trustScore: Number(row.trust_score),
      signatureStatus: row.signature_status,
      provenance: row.provenance,
      status: row.status,
      supersedesId: row.supersedes_id,
      memoryCreatedAt: row.memory_created_at,
    })),
    events: events.rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      eventType: row.event_type,
      actor: row.actor,
      reason: row.reason,
      evidenceHash: row.evidence_hash,
      runId: row.run_id,
      branch: row.branch_name,
      createdAt: row.created_at,
      fromThisRun: row.run_id === runId,
    })),
    interventions: interventions.rows.map((row) => ({
      memoryId: row.memory_id,
      state: row.state,
      actor: row.actor,
      reason: row.reason,
      evidenceHash: row.evidence_hash,
      createdAt: row.created_at,
    })),
    approvals: approvals.rows.map((row) => ({
      decision: row.decision,
      actor: row.actor,
      planHash: row.plan_hash,
      createdAt: row.created_at,
    })),
    journal: journal.rows.map((row) => ({
      actionKey: row.action_key,
      state: row.state,
      inputHash: row.input_hash,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
    source: {
      engine: "cockroachdb",
      tables: [
        "agent_runs",
        "memory_reads",
        "memories",
        "memory_events",
        "memory_interventions",
        "human_approvals",
        "action_journal",
      ],
    },
  };
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

    const quarantineEvent = await client.query(
      `INSERT INTO memory_events
        (workspace_id, id, memory_id, event_type, actor, reason, evidence_hash,
         run_id, branch_name)
       VALUES ($1, $2, $3, 'quarantined', 'lattice-guardian', $4, $5, $6, $7)
       RETURNING created_at`,
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
      // Wall time of the quarantine as recorded by CockroachDB, so the replay
      // header can cite a database timestamp rather than a client clock.
      quarantinedAt: quarantineEvent.rows[0].created_at,
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
