import { z } from "zod";
import {
  buildSafePlan,
  fallbackUnsafePlan,
  inspectMemory,
  stableHash,
} from "./guardrails.mjs";
import { sealEvidence } from "./evidence.mjs";
import { embedText, planWithBedrock } from "./providers.mjs";
import {
  approveRun,
  createTraceRun,
  getIncident,
  health,
  quarantineAndBranch,
  reconstructDecisionContext,
  retrieveMemories,
} from "./repository.mjs";
import { loadCockroachSkillContext } from "./skills.mjs";

const WORKSPACE_ID = "demo-acme-ops";

class InvalidJsonError extends Error {}

const traceSchema = z.object({
  incidentId: z.string().min(1).default("INC-0427"),
});

const quarantineSchema = z.object({
  runId: z.string().uuid(),
  memoryId: z.string().min(1),
  reason: z.string().min(12).max(500),
});

const approvalSchema = z.object({
  runId: z.string().uuid(),
  actor: z.string().min(2).max(100).default("human-operator"),
});

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": process.env.ALLOWED_ORIGIN || "*",
      "access-control-allow-headers": "content-type,x-idempotency-key",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError("Request body must be valid JSON.");
  }
}

async function trace(event) {
  const input = traceSchema.parse(parseBody(event));
  const idempotencyKey =
    event.headers?.["x-idempotency-key"] ||
    event.headers?.["X-Idempotency-Key"] ||
    stableHash({ workspaceId: WORKSPACE_ID, incidentId: input.incidentId, minute: new Date().toISOString().slice(0, 16) });

  const incident = await getIncident(WORKSPACE_ID, input.incidentId);
  if (!incident) return response(404, { error: "incident_not_found" });

  const skillContext = await loadCockroachSkillContext();
  const embedding = await embedText(`${incident.title}\n${incident.summary}`);
  const retrieved = await retrieveMemories(WORKSPACE_ID, embedding, 5);
  const policies = retrieved.filter((memory) => memory.kind === "policy");
  const evaluated = retrieved.map((memory) => ({
    ...memory,
    guardrail: inspectMemory(memory, policies),
  }));
  const conflicts = evaluated.filter((memory) => !memory.guardrail.safe);

  let plan;
  let planner = "bedrock";
  if (process.env.LATTICE_PLANNER_PROVIDER === "deterministic") {
    planner = "deterministic-safe-fallback";
    plan = fallbackUnsafePlan();
  } else {
    try {
      plan = await planWithBedrock({
        incident,
        memories: evaluated,
        skillGuardrails: skillContext.prompt,
      });
    } catch {
      planner = "deterministic-safe-fallback";
      plan = fallbackUnsafePlan();
    }
  }

  const run = await createTraceRun({
    workspaceId: WORKSPACE_ID,
    incidentId: input.incidentId,
    idempotencyKey,
    retrieved: evaluated,
    plan,
    conflicts,
    skillReceipts: skillContext.receipts,
  });

  return response(200, {
    runId: run.id,
    phase: run.phase,
    planner,
    incident,
    memories: evaluated,
    conflicts,
    plan,
    skillReceipts: skillContext.receipts,
    database: {
      role: "transactional + semantic system of record",
      isolation: "SERIALIZABLE",
      vectorIndex: "memory_embedding_idx",
      decisionHlc: run.decision_hlc,
      decisionWallTime: run.decision_wall_time,
    },
    replayed: run.replayed,
  });
}

async function quarantine(event) {
  const input = quarantineSchema.parse(parseBody(event));
  const idempotencyKey =
    event.headers?.["x-idempotency-key"] ||
    event.headers?.["X-Idempotency-Key"] ||
    `quarantine:${input.memoryId}`;

  const historical = await reconstructDecisionContext(WORKSPACE_ID, input.runId);
  const incident = await getIncident(WORKSPACE_ID, "INC-0427");
  const policies = historical.memories.filter((memory) => memory.kind === "policy");
  const reconstructed = historical.memories.map((memory) => ({
    ...memory,
    guardrail: inspectMemory(memory, policies),
  }));
  const trustedBranch = reconstructed.filter(
    (memory) => memory.id !== input.memoryId && memory.guardrail.safe,
  );

  let replayModelPlan = null;
  let replayPlanner = "verified-fallback";
  if (process.env.LATTICE_PLANNER_PROVIDER !== "deterministic") {
    try {
      replayModelPlan = await planWithBedrock({
        incident,
        memories: trustedBranch,
        skillGuardrails: (await loadCockroachSkillContext()).prompt,
        mode: "replay",
      });
      replayPlanner = "amazon-bedrock-guarded";
    } catch {
      replayPlanner = "verified-fallback";
    }
  }
  const safePlan = buildSafePlan(trustedBranch, replayModelPlan);

  const result = await quarantineAndBranch({
    workspaceId: WORKSPACE_ID,
    runId: input.runId,
    memoryId: input.memoryId,
    reason: input.reason,
    safePlan,
    idempotencyKey,
    temporalProof: historical.proof,
    replayPlanner,
  });

  const evidence = await sealEvidence({
    version: 1,
    workspaceId: WORKSPACE_ID,
    incidentId: "INC-0427",
    runId: input.runId,
    memoryEventId: result.eventId,
    quarantinedMemoryId: result.quarantinedMemoryId,
    reason: input.reason,
    branch: result.branch,
    plan: result.plan,
    inputHash: result.inputHash,
    sealedAt: new Date().toISOString(),
  });

  return response(200, { ...result, evidence });
}

async function approve(event) {
  const input = approvalSchema.parse(parseBody(event));
  const idempotencyKey =
    event.headers?.["x-idempotency-key"] ||
    event.headers?.["X-Idempotency-Key"] ||
    `human-approval:${input.runId}`;

  const result = await approveRun({
    workspaceId: WORKSPACE_ID,
    runId: input.runId,
    actor: input.actor,
    idempotencyKey,
  });
  const evidence = await sealEvidence({
    version: 1,
    type: "human-approval",
    workspaceId: WORKSPACE_ID,
    incidentId: "INC-0427",
    runId: input.runId,
    branch: result.branch,
    actor: result.actor,
    planHash: result.planHash,
    executionGate: result.executionGate,
    sideEffectsExecuted: result.sideEffectsExecuted,
    sealedAt: new Date().toISOString(),
  });

  return response(200, { ...result, evidence });
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = event.rawPath || event.path || "/";

  if (method === "OPTIONS") return response(204, {});

  try {
    if (method === "GET" && path.endsWith("/health")) {
      const database = await health();
      const skills = await loadCockroachSkillContext();
      return response(200, {
        ok: true,
        service: "lattice-incident-agent",
        database,
        skills: skills.receipts,
        aws: {
          region: process.env.AWS_REGION || "us-east-1",
          bedrock: process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0",
          evidenceStore: process.env.EVIDENCE_BUCKET ? "s3-versioned" : "not-configured",
        },
      });
    }
    if (method === "POST" && path.endsWith("/trace")) return await trace(event);
    if (method === "POST" && path.endsWith("/quarantine")) return await quarantine(event);
    if (method === "POST" && path.endsWith("/approve")) return await approve(event);
    return response(404, { error: "route_not_found", path, method });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_failed",
        path,
        code: error?.code,
        message: error?.message,
      }),
    );
    if (error instanceof z.ZodError) {
      return response(400, { error: "invalid_request", details: error.issues });
    }
    if (error instanceof InvalidJsonError) {
      return response(400, { error: "invalid_json", message: error.message });
    }
    return response(500, {
      error: "request_failed",
      message: "The agent could not complete this trace. No action was executed.",
      requestId: event.requestContext?.requestId ?? null,
    });
  }
}
