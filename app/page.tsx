"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Lattice control room.
 *
 * Every value rendered below comes from the agent API, which reads it from
 * CockroachDB. There is no fixture data in this file: before a trace is run the
 * UI is deliberately empty, and each panel renders whatever the backend
 * returned for the current run.
 */

const DEFAULT_REMOTE_API = "https://x8vncko1s0.execute-api.us-east-1.amazonaws.com";

type Violation = { id: string; reason: string };
type Guardrail = { safe: boolean; violations: Violation[] };

type Memory = {
  id: string;
  kind: string;
  title: string;
  content: string;
  trustScore: number;
  provenance: Record<string, unknown> | null;
  signatureStatus: string;
  status: string;
  supersedesId: string | null;
  createdAt?: string | null;
  similarity: number;
  cohortAgreement: number;
  semanticAnomaly: number;
  guardrail: Guardrail;
};

type PlanAction = {
  key: string;
  title: string;
  mode: string;
  requiresApproval?: boolean;
  memoryIds?: string[];
};

type Plan = {
  version?: number;
  branch?: string;
  summary?: string;
  confidence?: number | string;
  generatedBy?: string;
  sourceMemoryIds?: string[];
  actions: PlanAction[];
};

type Incident = {
  id: string;
  title: string;
  severity: string;
  region: string;
  status: string;
  summary: string;
  created_at: string;
};

type TraceResponse = {
  runId: string;
  phase: string;
  planner: string;
  incident: Incident;
  memories: Memory[];
  conflicts: Memory[];
  plan: Plan;
  skillReceipts: { name: string; version: string; source: string }[];
  database: {
    role: string;
    isolation: string;
    vectorIndex: string;
    decisionHlc: string | null;
    decisionWallTime: string | null;
  };
};

type QuarantineResponse = {
  runId: string;
  phase: string;
  branch: string;
  plan: Plan;
  quarantinedMemoryId: string;
  eventId: string;
  quarantinedAt?: string | null;
  temporalProof: {
    engine: string;
    queryMode: string;
    exactHlc: string;
    reconstructedRows: number;
  };
  replayPlanner: string;
  evidence: { stored: boolean; hash: string; key?: string; versionId?: string | null };
};

type ApprovalResponse = {
  phase: string;
  branch: string;
  actor: string;
  planHash: string;
  executionGate: string;
  sideEffectsExecuted: boolean;
  evidence: { stored: boolean; hash: string; versionId?: string | null };
};

type LineageEvent = {
  id: string;
  memoryId: string;
  eventType: string;
  actor: string;
  reason: string;
  evidenceHash: string;
  branch: string | null;
  createdAt: string;
  fromThisRun: boolean;
};

type Lineage = {
  run: {
    phase: string;
    branch: string;
    decisionHlc: string | null;
    decisionWallTime: string | null;
    createdAt: string;
  };
  reads: {
    memoryId: string;
    rank: number;
    decision: string;
    readAt: string;
    memoryCreatedAt: string;
  }[];
  events: LineageEvent[];
  interventions: { memoryId: string; state: string; createdAt: string; reason: string }[];
  approvals: { decision: string; actor: string; createdAt: string }[];
  source: { engine: string; tables: string[] };
};

type TrustState = "verified" | "unverified" | "quarantined";

type TimelineNode = {
  key: string;
  memoryId: string;
  type: "written" | "referenced" | "flagged" | "quarantined" | "approved";
  at: string | null;
  label: string;
  detail: string;
  trust: TrustState;
};

/** Deterministic 6-char display hash so a real memory id reads like a commit. */
function shortHash(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function trustOf(memory: Memory, quarantinedId?: string | null): TrustState {
  if (quarantinedId && memory.id === quarantinedId) return "quarantined";
  if (memory.signatureStatus === "verified" && memory.guardrail.safe) return "verified";
  return "unverified";
}

/** Normalises an action for cross-plan matching in the diff. */
function actionTokens(action: PlanAction) {
  return new Set(
    `${action.key} ${action.title}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3),
  );
}

function sameAction(a: PlanAction, b: PlanAction) {
  if (a.key === b.key) return true;
  const left = actionTokens(a);
  const right = actionTokens(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  left.forEach((token) => {
    if (right.has(token)) shared += 1;
  });
  return shared / Math.min(left.size, right.size) >= 0.5;
}

export default function Home() {
  const [api, setApi] = useState<string>("");
  const [connection, setConnection] = useState<"checking" | "live" | "down">("checking");
  const [view, setView] = useState<"timeline" | "diff">("timeline");

  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantineResponse | null>(null);
  const [approval, setApproval] = useState<ApprovalResponse | null>(null);
  const [lineage, setLineage] = useState<Lineage | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "trace" | "quarantine" | "approve">(null);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    const configured = process.env.NEXT_PUBLIC_LATTICE_API_URL;
    const base = configured
      ? configured.replace(/\/$/, "")
      : /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
        ? "http://127.0.0.1:8787"
        : DEFAULT_REMOTE_API;
    setApi(base);

    fetch(`${base}/health`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("unhealthy");
        setConnection("live");
      })
      .catch(() => setConnection("down"));
  }, []);

  const loadLineage = useCallback(
    async (runId: string) => {
      try {
        const response = await fetch(`${api}/lineage?runId=${encodeURIComponent(runId)}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        setLineage(await response.json());
      } catch {
        // Lineage enriches the timeline; the run data already carries the truth.
      }
    },
    [api],
  );

  async function post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || payload.message || `${path} failed (${response.status})`);
    }
    return response.json();
  }

  async function runTrace() {
    setBusy("trace");
    setError(null);
    setQuarantine(null);
    setApproval(null);
    setLineage(null);
    setSelected(null);
    try {
      const payload = await post<TraceResponse>(
        "/trace",
        { incidentId: "INC-0427" },
        `web-trace-${crypto.randomUUID()}`,
      );
      setTrace(payload);
      setConnection("live");
      setView("timeline");
      const firstConflict = payload.conflicts[0]?.id ?? payload.memories[0]?.id ?? null;
      setSelected(firstConflict);
      void loadLineage(payload.runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Trace failed");
      setConnection("down");
    } finally {
      setBusy(null);
    }
  }

  async function runQuarantine(memoryId: string) {
    if (!trace) return;
    setBusy("quarantine");
    setError(null);
    try {
      const payload = await post<QuarantineResponse>(
        "/quarantine",
        {
          runId: trace.runId,
          memoryId,
          reason: `Quarantined by operator: ${
            trace.memories
              .find((memory) => memory.id === memoryId)
              ?.guardrail.violations.map((violation) => violation.id)
              .join(", ") || "failed provenance checks"
          }`,
        },
        `web-quarantine-${trace.runId}-${memoryId}`,
      );
      setQuarantine(payload);
      setView("diff");
      setReplaying(true);
      window.setTimeout(() => setReplaying(false), 1900);
      void loadLineage(trace.runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Quarantine failed");
    } finally {
      setBusy(null);
    }
  }

  async function runApprove() {
    if (!trace) return;
    setBusy("approve");
    setError(null);
    try {
      const payload = await post<ApprovalResponse>(
        "/approve",
        { runId: trace.runId, actor: "human-operator" },
        `web-approval-${trace.runId}`,
      );
      setApproval(payload);
      void loadLineage(trace.runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Approval failed");
    } finally {
      setBusy(null);
    }
  }

  const quarantinedId = quarantine?.quarantinedMemoryId ?? null;

  /**
   * The timeline is assembled from rows the backend returned. When /lineage is
   * available its real event rows win; otherwise we fall back to the timestamps
   * carried on the trace and quarantine responses. Nothing here is invented.
   */
  const timeline = useMemo<TimelineNode[]>(() => {
    if (!trace) return [];
    const nodes: TimelineNode[] = [];
    const readAt = lineage?.run.decisionWallTime ?? trace.database.decisionWallTime;

    for (const memory of trace.memories) {
      const trust = trustOf(memory, quarantinedId);
      const read = lineage?.reads.find((row) => row.memoryId === memory.id);
      const writtenAt = read?.memoryCreatedAt ?? memory.createdAt ?? null;

      if (writtenAt) {
        nodes.push({
          key: `${memory.id}:written`,
          memoryId: memory.id,
          type: "written",
          at: writtenAt,
          label: "written",
          detail: `${memory.kind} · ${memory.signatureStatus}`,
          trust: trust === "quarantined" ? "quarantined" : trust,
        });
      }

      nodes.push({
        key: `${memory.id}:referenced`,
        memoryId: memory.id,
        type: "referenced",
        at: read?.readAt ?? readAt,
        label: "referenced",
        detail: `rank ${read?.rank ?? trace.memories.indexOf(memory) + 1} · cos ${memory.similarity.toFixed(4)}`,
        trust,
      });

      if (!memory.guardrail.safe) {
        nodes.push({
          key: `${memory.id}:flagged`,
          memoryId: memory.id,
          type: "flagged",
          at: read?.readAt ?? readAt,
          label: "flagged",
          detail: memory.guardrail.violations.map((violation) => violation.id).join(" · "),
          trust: trust === "quarantined" ? "quarantined" : "unverified",
        });
      }
    }

    for (const intervention of lineage?.interventions ?? []) {
      nodes.push({
        key: `${intervention.memoryId}:quarantined`,
        memoryId: intervention.memoryId,
        type: "quarantined",
        at: intervention.createdAt,
        label: intervention.state,
        detail: intervention.reason,
        trust: "quarantined",
      });
    }
    if (!lineage && quarantine) {
      nodes.push({
        key: `${quarantine.quarantinedMemoryId}:quarantined`,
        memoryId: quarantine.quarantinedMemoryId,
        type: "quarantined",
        at: null,
        label: "quarantined",
        detail: `branch ${quarantine.branch}`,
        trust: "quarantined",
      });
    }

    for (const record of lineage?.approvals ?? []) {
      nodes.push({
        key: `approval:${record.createdAt}`,
        memoryId: "—",
        type: "approved",
        at: record.createdAt,
        label: `plan ${record.decision}`,
        detail: `by ${record.actor}`,
        trust: "verified",
      });
    }
    if (!lineage?.approvals.length && approval) {
      nodes.push({
        key: "approval:local",
        memoryId: "—",
        type: "approved",
        at: null,
        label: "plan approved",
        detail: `by ${approval.actor}`,
        trust: "verified",
      });
    }

    return nodes.sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at).getTime() - new Date(b.at).getTime();
    });
  }, [trace, lineage, quarantine, approval, quarantinedId]);

  const selectedMemory = trace?.memories.find((memory) => memory.id === selected) ?? null;

  const influencedActions = useMemo(() => {
    if (!selectedMemory || !trace) return [] as { plan: string; action: PlanAction }[];
    const rows: { plan: string; action: PlanAction }[] = [];
    for (const action of trace.plan.actions ?? []) {
      if (action.memoryIds?.includes(selectedMemory.id)) rows.push({ plan: "v1", action });
    }
    for (const action of quarantine?.plan.actions ?? []) {
      if (action.memoryIds?.includes(selectedMemory.id)) rows.push({ plan: "v2", action });
    }
    return rows;
  }, [selectedMemory, trace, quarantine]);

  const diff = useMemo(() => {
    const before = trace?.plan.actions ?? [];
    const after = quarantine?.plan.actions ?? [];
    if (!after.length) return null;
    return {
      removed: before.filter((action) => !after.some((other) => sameAction(action, other))),
      kept: before.filter((action) => after.some((other) => sameAction(action, other))),
      added: after.filter((action) => !before.some((other) => sameAction(action, other))),
      after,
    };
  }, [trace, quarantine]);

  const blockedMemories = trace?.conflicts ?? [];
  const unresolved = blockedMemories.filter((memory) => memory.id !== quarantinedId);
  const canApprove = Boolean(quarantine) && unresolved.length === 0 && !approval;

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">lattice</span>
          <span className="brand-sub">memory provenance</span>
        </div>

        <nav className="tabs" aria-label="Views">
          <button
            className={view === "timeline" ? "tab is-active" : "tab"}
            onClick={() => setView("timeline")}
          >
            log
          </button>
          <button
            className={view === "diff" ? "tab is-active" : "tab"}
            onClick={() => setView("diff")}
            disabled={!diff}
          >
            diff
          </button>
        </nav>

        <div className="top-meta">
          <span className={`conn conn-${connection}`}>
            {connection === "live" ? "cockroachdb live" : connection === "down" ? "api unreachable" : "connecting"}
          </span>
          {trace ? <code className="run-id">run {shortHash(trace.runId)}</code> : null}
        </div>
      </header>

      {trace ? (
        <section className="incident-bar">
          <span className="sev">{trace.incident.severity}</span>
          <strong>{trace.incident.title}</strong>
          <code>{trace.incident.id}</code>
          <code className="dim">{trace.incident.region}</code>
          <span className="spacer" />
          <code className="dim">
            AS OF SYSTEM TIME{" "}
            {quarantine?.temporalProof.exactHlc ?? trace.database.decisionHlc ?? "—"}
          </code>
        </section>
      ) : null}

      {error ? (
        <div className="error-bar" role="alert">
          {error}
        </div>
      ) : null}

      {!trace ? (
        <section className="empty">
          <h1>Memory that can prove itself.</h1>
          <p>
            Lattice records which memories caused an agent plan, tests them against signed
            policy and provenance, and blocks side effects when recall cannot be trusted.
          </p>
          <button className="btn btn-primary" onClick={runTrace} disabled={busy !== null || !api}>
            {busy === "trace" ? "tracing…" : "Run memory trace"}
          </button>
          <p className="empty-note">
            Nothing on this screen is fixture data. Every node, score and timestamp is read
            from CockroachDB when the trace runs.
          </p>
        </section>
      ) : view === "timeline" ? (
        <section className="log-view">
          <div className="graph" role="list" aria-label="Memory event graph">
            {timeline.map((node) => {
              const isSelected = node.memoryId === selected;
              return (
                <button
                  role="listitem"
                  key={node.key}
                  className={`row row-${node.type} trust-${node.trust} ${isSelected ? "is-selected" : ""}`}
                  onClick={() => node.memoryId !== "—" && setSelected(node.memoryId)}
                >
                  <span className="rail" aria-hidden="true">
                    <i className={`node node-${node.trust} glyph-${node.type}`} />
                  </span>
                  <code className="hash">#{shortHash(node.memoryId)}</code>
                  <span className="row-label">{node.label}</span>
                  <span className="row-detail">{node.detail}</span>
                  <code className="row-time">{formatTime(node.at)}</code>
                </button>
              );
            })}
          </div>

          <aside className="inspect">
            {selectedMemory ? (
              <>
                <div className="inspect-head">
                  <code className="hash big">#{shortHash(selectedMemory.id)}</code>
                  <span className={`badge trust-${trustOf(selectedMemory, quarantinedId)}`}>
                    {trustOf(selectedMemory, quarantinedId)}
                  </span>
                </div>
                <h2>{selectedMemory.title}</h2>
                <p className="content">{selectedMemory.content}</p>

                <dl className="meta">
                  <div>
                    <dt>memory id</dt>
                    <dd><code>{selectedMemory.id}</code></dd>
                  </div>
                  <div>
                    <dt>written</dt>
                    <dd><code>{formatTime(selectedMemory.createdAt)}</code></dd>
                  </div>
                  <div>
                    <dt>signer</dt>
                    <dd>
                      <code>
                        {String(
                          (selectedMemory.provenance as { reviewer?: string })?.reviewer ??
                            "unsigned",
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>source</dt>
                    <dd>
                      <code>
                        {String((selectedMemory.provenance as { source?: string })?.source ?? "—")}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>signature</dt>
                    <dd><code>{selectedMemory.signatureStatus}</code></dd>
                  </div>
                  <div>
                    <dt>trust</dt>
                    <dd><code>{selectedMemory.trustScore}/100</code></dd>
                  </div>
                  <div>
                    <dt>cosine</dt>
                    <dd><code>{selectedMemory.similarity.toFixed(6)}</code></dd>
                  </div>
                  <div>
                    <dt>cohort agreement</dt>
                    <dd><code>{selectedMemory.cohortAgreement.toFixed(4)}</code></dd>
                  </div>
                  <div>
                    <dt>semantic anomaly</dt>
                    <dd><code>{selectedMemory.semanticAnomaly.toFixed(4)}</code></dd>
                  </div>
                  <div>
                    <dt>as of system time</dt>
                    <dd>
                      <code>
                        {quarantine?.temporalProof.exactHlc ?? trace.database.decisionHlc ?? "—"}
                      </code>
                    </dd>
                  </div>
                </dl>

                {influencedActions.length ? (
                  <div className="influenced">
                    <span className="section-label">actions influenced</span>
                    {influencedActions.map(({ plan, action }) => (
                      <div className="influenced-row" key={`${plan}:${action.key}`}>
                        <code>{plan}</code>
                        <span>{action.title}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {!selectedMemory.guardrail.safe ? (
                  <div className="blocked" role="alert">
                    <strong>This memory cannot be trusted to inform an action.</strong>
                    <ul>
                      {selectedMemory.guardrail.violations.map((violation) => (
                        <li key={violation.id}>
                          <code>{violation.id}</code>
                          <span>{violation.reason}</span>
                        </li>
                      ))}
                    </ul>
                    {selectedMemory.id !== quarantinedId ? (
                      <button
                        className="btn btn-danger"
                        onClick={() => runQuarantine(selectedMemory.id)}
                        disabled={busy !== null}
                      >
                        {busy === "quarantine" ? "replaying…" : "Quarantine and replay"}
                      </button>
                    ) : (
                      <span className="resolved">quarantined on {quarantine?.branch}</span>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="inspect-empty">Select a node to inspect its provenance.</p>
            )}
          </aside>
        </section>
      ) : diff ? (
        <section className={`diff-view ${replaying ? "is-replaying" : ""}`}>
          <div className="diff-head">
            <code>
              {(() => {
                const at =
                  lineage?.interventions[0]?.createdAt ?? quarantine?.quarantinedAt ?? null;
                return at ? `Replay at ${formatTime(at)} — ` : "Replay — ";
              })()}
              excluding memory {quarantinedId} (#{shortHash(quarantinedId ?? "")}), reason:{" "}
              {trace.memories
                .find((memory) => memory.id === quarantinedId)
                ?.guardrail.violations.map((violation) => violation.id)
                .join(", ") || "failed provenance"}
            </code>
            <code className="dim">
              {quarantine?.temporalProof.queryMode} {quarantine?.temporalProof.exactHlc} ·{" "}
              {quarantine?.temporalProof.reconstructedRows} rows reconstructed
            </code>
          </div>

          <div className="panes">
            <div className="pane pane-before">
              <div className="pane-head">
                <span>plan v{trace.plan.version ?? 1}</span>
                <code className="dim">branch main · {trace.planner}</code>
              </div>
              {trace.plan.summary ? <p className="pane-summary">{trace.plan.summary}</p> : null}
              <ol className="steps">
                {(trace.plan.actions ?? []).map((action) => {
                  const removed = diff.removed.some((other) => other.key === action.key);
                  return (
                    <li key={action.key} className={removed ? "step removed" : "step"}>
                      <span className="sign">{removed ? "−" : " "}</span>
                      <span className="step-body">
                        <span className="step-title">{action.title}</span>
                        <code className="step-meta">
                          {action.mode}
                          {action.memoryIds?.length ? ` · ${action.memoryIds.join(" ")}` : ""}
                        </code>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className="pane pane-after">
              <div className="pane-head">
                <span>plan v{quarantine?.plan.version ?? 2}</span>
                <code className="dim">
                  branch {quarantine?.branch} · {quarantine?.replayPlanner}
                </code>
              </div>
              {quarantine?.plan.summary ? (
                <p className="pane-summary">{quarantine.plan.summary}</p>
              ) : null}
              <ol className="steps">
                {diff.after.map((action, index) => {
                  const added = diff.added.some((other) => other.key === action.key);
                  return (
                    <li
                      key={action.key}
                      className={added ? "step added" : "step"}
                      style={{ animationDelay: `${520 + index * 130}ms` }}
                    >
                      <span className="sign">{added ? "+" : " "}</span>
                      <span className="step-body">
                        <span className="step-title">{action.title}</span>
                        <code className="step-meta">
                          {action.mode}
                          {action.requiresApproval ? " · approval" : ""}
                          {action.memoryIds?.length ? ` · ${action.memoryIds.join(" ")}` : ""}
                        </code>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          <div className="gate">
            <div className="gate-facts">
              <code>
                sources {quarantine?.plan.sourceMemoryIds?.join(" ") ?? "—"}
              </code>
              {quarantine?.evidence.stored ? (
                <code className="dim">
                  evidence {quarantine.evidence.hash.slice(0, 12)}…
                  {quarantine.evidence.versionId ? ` · s3 v${quarantine.evidence.versionId.slice(0, 8)}` : ""}
                </code>
              ) : null}
            </div>

            {approval ? (
              <span className="approved-note">
                approved by {approval.actor} · execution gate {approval.executionGate} · side
                effects executed: {String(approval.sideEffectsExecuted)}
              </span>
            ) : (
              <button
                className="btn btn-approve"
                onClick={runApprove}
                disabled={!canApprove || busy !== null}
                title={
                  canApprove
                    ? "Approve the replayed plan"
                    : "Resolve every quarantined memory first"
                }
              >
                {busy === "approve" ? "approving…" : "Approve recovery plan"}
              </button>
            )}
          </div>
        </section>
      ) : null}

      {trace ? (
        <footer className="foot">
          <code>vector index {trace.database.vectorIndex}</code>
          <code>{trace.database.isolation}</code>
          <code>
            skills {trace.skillReceipts.map((receipt) => receipt.name).join(" · ")}
          </code>
          <span className="spacer" />
          {lineage ? (
            <code className="dim">lineage from {lineage.source.tables.length} tables</code>
          ) : null}
          <button className="btn btn-ghost" onClick={runTrace} disabled={busy !== null}>
            new trace
          </button>
        </footer>
      ) : null}
    </main>
  );
}
