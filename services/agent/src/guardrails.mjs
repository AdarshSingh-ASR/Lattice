import { createHash } from "node:crypto";

const FORBIDDEN_PATTERNS = [
  {
    id: "AUTH_BYPASS",
    pattern: /\b(bypass|disable|skip)\b.{0,40}\b(auth|jwt|signature|verification)\b/i,
    reason: "Authentication controls cannot be bypassed in production.",
  },
  {
    id: "UNBOUNDED_BLAST_RADIUS",
    pattern: /\b(all traffic|100% traffic|every region|global rollout)\b/i,
    reason: "Recovery actions must begin with a bounded blast radius.",
  },
  {
    id: "DESTRUCTIVE_WITHOUT_APPROVAL",
    pattern: /\b(drop|delete|truncate|purge)\b/i,
    reason: "Destructive actions require explicit human approval.",
  },
];

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function inspectMemory(memory, policies = []) {
  const violations = [];

  if (memory.signatureStatus !== "verified") {
    violations.push({
      id: "UNVERIFIED_PROVENANCE",
      reason: "Memory has no verified human or system signature.",
    });
  }

  if (memory.trustScore < 50) {
    violations.push({
      id: "LOW_TRUST",
      reason: `Trust score ${memory.trustScore} is below the execution threshold.`,
    });
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(memory.content)) {
      violations.push({ id: rule.id, reason: rule.reason });
    }
  }

  for (const policy of policies) {
    const terms = policy.content
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 5);
    const overlap = terms.filter((term) => memory.content.toLowerCase().includes(term));
    if (overlap.length > 2 && memory.kind !== "policy" && memory.trustScore < policy.trustScore) {
      violations.push({
        id: "SIGNED_POLICY_CONFLICT",
        reason: `Memory conflicts with higher-trust policy ${policy.id}.`,
      });
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}

export function buildSafePlan(memories) {
  const usable = memories.filter((memory) => !memory.guardrail?.violations?.length);
  const sourceIds = usable.map((memory) => memory.id);

  return {
    version: 2,
    branch: "replay/0427-safe",
    confidence: 0.96,
    sourceMemoryIds: sourceIds,
    actions: [
      {
        key: "freeze-canary",
        title: "Freeze canary at 10%",
        mode: "reversible",
        requiresApproval: false,
      },
      {
        key: "restore-issuer-overlap",
        title: "Restore JWT issuer overlap",
        mode: "human-approved",
        requiresApproval: true,
      },
      {
        key: "rollback-checkout",
        title: "Rollback checkout v3.8.1",
        mode: "idempotent",
        requiresApproval: false,
      },
      {
        key: "verify-recovery",
        title: "Verify authentication and error budget",
        mode: "read-only",
        requiresApproval: false,
      },
    ],
  };
}

export function fallbackUnsafePlan() {
  return {
    version: 1,
    branch: "main",
    confidence: 0.61,
    actions: [
      {
        key: "freeze-canary",
        title: "Freeze canary traffic at 10%",
        mode: "reversible",
        requiresApproval: false,
      },
      {
        key: "bypass-signatures",
        title: "Temporarily bypass JWT signature checks",
        mode: "blocked",
        requiresApproval: true,
      },
      {
        key: "rotate-key",
        title: "Rotate gateway signing key",
        mode: "human-approved",
        requiresApproval: true,
      },
    ],
  };
}
