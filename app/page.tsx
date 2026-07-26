"use client";

import { useEffect, useMemo, useState } from "react";

type Phase = "ready" | "scanning" | "conflict" | "replaying" | "resolved";

type Memory = {
  id: string;
  label: string;
  detail: string;
  trust: number;
  similarity: number;
  kind: "evidence" | "memory" | "policy" | "poison";
  position: string;
};

const DEFAULT_REMOTE_API = "https://x8vncko1s0.execute-api.us-east-1.amazonaws.com";

const memories: Memory[] = [
  {
    id: "E-17",
    label: "Gateway telemetry",
    detail: "502 rate crossed 41% at 09:42:18Z",
    trust: 99,
    similarity: 91,
    kind: "evidence",
    position: "node-a",
  },
  {
    id: "M-184",
    label: "Verified recovery",
    detail: "Rollback canary before credential rotation",
    trust: 98,
    similarity: 93,
    kind: "memory",
    position: "node-b",
  },
  {
    id: "M-211",
    label: "Unsigned workaround",
    detail: "Disable signature verification during key drift",
    trust: 22,
    similarity: 89,
    kind: "poison",
    position: "node-c",
  },
  {
    id: "M-176",
    label: "Key rotation pattern",
    detail: "Missing issuer overlap creates transient 401 / 502",
    trust: 94,
    similarity: 86,
    kind: "memory",
    position: "node-d",
  },
  {
    id: "P-07",
    label: "Production policy",
    detail: "Authentication controls can never be bypassed",
    trust: 100,
    similarity: 81,
    kind: "policy",
    position: "node-e",
  },
];

const incidentEvents = [
  ["09:42:18", "Gateway 5xx rate", "2.1% → 41.3%", "critical"],
  ["09:42:06", "Canary v3.8.1", "10% traffic", "warning"],
  ["09:41:54", "JWT issuer", "overlap missing", "warning"],
  ["09:41:32", "Checkout p95", "312ms → 4.8s", "critical"],
];

const safeActions = [
  ["01", "Freeze canary at 10%", "Reversible", "ready"],
  ["02", "Restore issuer overlap", "Human approval", "approval"],
  ["03", "Rollback checkout v3.8.1", "Idempotent", "ready"],
  ["04", "Verify auth + error budget", "Read-only", "ready"],
];

function PhaseButton({
  phase,
  onRun,
  onQuarantine,
  onReset,
}: {
  phase: Phase;
  onRun: () => void;
  onQuarantine: () => void;
  onReset: () => void;
}) {
  if (phase === "ready") {
    return (
      <button className="primary-button" onClick={onRun}>
        <span>Run memory trace</span>
        <span aria-hidden="true">↗</span>
      </button>
    );
  }

  if (phase === "scanning" || phase === "replaying") {
    return (
      <button className="primary-button is-loading" disabled>
        <span className="spinner" aria-hidden="true" />
        <span>{phase === "scanning" ? "Tracing causal memory" : "Replaying safe branch"}</span>
      </button>
    );
  }

  if (phase === "conflict") {
    return (
      <button className="danger-button" onClick={onQuarantine}>
        <span>Quarantine + replay</span>
        <span aria-hidden="true">⌁</span>
      </button>
    );
  }

  return (
    <button className="primary-button" onClick={onReset}>
      <span>Replay incident again</span>
      <span aria-hidden="true">↻</span>
    </button>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("ready");
  const [selectedMemory, setSelectedMemory] = useState<Memory>(memories[1]);
  const [now, setNow] = useState("09:42:21Z");
  const [runId, setRunId] = useState<string | null>(null);
  const [memoryPlane, setMemoryPlane] = useState<"checking" | "live" | "demo">("checking");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }).format(new Date()) + "Z",
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const apiBase = resolveApiBase();
    if (!apiBase) {
      const timer = window.setTimeout(() => setMemoryPlane("demo"), 0);
      return () => window.clearTimeout(timer);
    }
    fetch(`${apiBase}/health`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("unavailable");
        setMemoryPlane("live");
      })
      .catch(() => setMemoryPlane("demo"));
  }, []);

  const statusCopy = useMemo(() => {
    if (phase === "ready") return "Awaiting trace";
    if (phase === "scanning") return "Retrieving 4 memories";
    if (phase === "conflict") return "Memory conflict found";
    if (phase === "replaying") return "Building trusted branch";
    return "Recovery plan verified";
  }, [phase]);

  function resolveApiBase() {
    const configured = process.env.NEXT_PUBLIC_LATTICE_API_URL;
    if (configured) return configured.replace(/\/$/, "");
    if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
      return "http://127.0.0.1:8787";
    }
    return DEFAULT_REMOTE_API;
  }

  async function runTrace() {
    setPhase("scanning");
    const apiBase = resolveApiBase();
    if (apiBase) {
      try {
        const response = await fetch(`${apiBase}/trace`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": `web-trace-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ incidentId: "INC-0427" }),
        });
        if (!response.ok) throw new Error("trace failed");
        const payload = await response.json();
        setRunId(payload.runId);
        setMemoryPlane("live");
        setSelectedMemory(memories[2]);
        setPhase("conflict");
        return;
      } catch {
        setMemoryPlane("demo");
      }
    }
    window.setTimeout(() => {
      setSelectedMemory(memories[2]);
      setPhase("conflict");
    }, 1150);
  }

  async function quarantineAndReplay() {
    setPhase("replaying");
    const apiBase = resolveApiBase();
    if (apiBase && runId) {
      try {
        const response = await fetch(`${apiBase}/quarantine`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": `web-quarantine-${runId}`,
          },
          body: JSON.stringify({
            runId,
            memoryId: "M-211",
            reason: "Unsigned memory conflicts with signed authentication policy P-07.",
          }),
        });
        if (!response.ok) throw new Error("replay failed");
        setMemoryPlane("live");
        setSelectedMemory(memories[1]);
        setPhase("resolved");
        return;
      } catch {
        setMemoryPlane("demo");
      }
    }
    window.setTimeout(() => {
      setSelectedMemory(memories[1]);
      setPhase("resolved");
    }, 1250);
  }

  function resetDemo() {
    setSelectedMemory(memories[1]);
    setRunId(null);
    setPhase("ready");
  }

  const traceActive = phase !== "ready";
  const conflictVisible = phase === "conflict" || phase === "replaying";
  const resolved = phase === "resolved";

  return (
    <main className={`app-shell phase-${phase}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="brand-name">LATTICE</div>
            <div className="brand-subtitle">Incident memory control plane</div>
          </div>
        </div>

        <div className="topbar-center" aria-label="System status">
          <span className={`live-dot plane-${memoryPlane}`} />
          <span>{memoryPlane === "live" ? "MEMORY PLANE LIVE" : memoryPlane === "checking" ? "CONNECTING" : "DEMO MEMORY"}</span>
          <span className="slash">/</span>
          <span>COCKROACHDB</span>
          <span className="slash">/</span>
          <span>AWS</span>
        </div>

        <div className="topbar-meta">
          <span className="utc-time">{now}</span>
          <button className="avatar-button" aria-label="Operator menu">
            AO
          </button>
        </div>
      </header>

      <section className="mission-strip" aria-label="Active incident">
        <div className="mission-id">
          <span className="eyebrow">ACTIVE INCIDENT</span>
          <strong>INC-0427</strong>
        </div>
        <div className="mission-title">
          <span className="severity-pill">SEV-1</span>
          <h1>Checkout degradation</h1>
          <span className="region-label">US-EAST-1</span>
        </div>
        <div className={`trace-status status-${phase}`}>
          <span className="status-symbol" aria-hidden="true">
            {resolved ? "✓" : conflictVisible ? "!" : traceActive ? "◌" : "•"}
          </span>
          <span>{statusCopy}</span>
        </div>
      </section>

      <section className="workspace">
        <aside className="signal-panel panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">01 / LIVE SIGNAL</span>
              <h2>What changed</h2>
            </div>
            <span className="count-badge">04</span>
          </div>

          <div className="metric-hero">
            <div className="metric-label">CHECKOUT AVAILABILITY</div>
            <div className="metric-value">
              58.7<span>%</span>
            </div>
            <div className="spark-bars" aria-label="Availability falling">
              {[78, 83, 76, 71, 66, 60, 51, 44, 30, 22].map((height, index) => (
                <i key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="metric-delta">−40.8% in 49 seconds</div>
          </div>

          <div className="event-list">
            {incidentEvents.map(([time, label, value, severity]) => (
              <div className="event-row" key={label}>
                <span className="event-time">{time}</span>
                <div className="event-copy">
                  <strong>{label}</strong>
                  <span>{value}</span>
                </div>
                <span className={`event-indicator ${severity}`} />
              </div>
            ))}
          </div>

          <div className="causal-hypothesis">
            <span className="eyebrow">LIVE HYPOTHESIS</span>
            <p>
              Canary deployment and incomplete JWT issuer overlap are jointly
              driving gateway failures.
            </p>
            <div>
              <span>Confidence</span>
              <strong>{resolved ? "96%" : "78%"}</strong>
            </div>
          </div>
        </aside>

        <section className="memory-panel panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">02 / CAUSAL MEMORY</span>
              <h2>Why the agent believes it</h2>
            </div>
            <div className="latency-chip">
              <span>VECTOR RECALL</span>
              <strong>43ms</strong>
            </div>
          </div>

          <div className={`memory-canvas ${traceActive ? "is-active" : ""}`}>
            <div className="grid-plane" aria-hidden="true" />
            <div className="connection line-1" aria-hidden="true" />
            <div className="connection line-2" aria-hidden="true" />
            <div className="connection line-3" aria-hidden="true" />
            <div className="connection line-4" aria-hidden="true" />
            <div className="connection line-5" aria-hidden="true" />

            <div className="incident-core">
              <span>INC</span>
              <strong>0427</strong>
              <small>NOW</small>
            </div>

            {memories.map((memory) => (
              <button
                key={memory.id}
                className={[
                  "memory-node",
                  memory.position,
                  `kind-${memory.kind}`,
                  selectedMemory.id === memory.id ? "is-selected" : "",
                  memory.kind === "poison" && resolved ? "is-quarantined" : "",
                ].join(" ")}
                onClick={() => setSelectedMemory(memory)}
                aria-label={`Inspect memory ${memory.id}: ${memory.label}`}
              >
                <span className="node-kicker">{memory.id}</span>
                <strong>{memory.label}</strong>
                <span className="node-score">
                  {memory.kind === "poison" && resolved ? "QUARANTINED" : `${memory.similarity}% match`}
                </span>
              </button>
            ))}

            <div className="canvas-legend">
              <span><i className="legend-dot verified" /> verified</span>
              <span><i className="legend-dot evidence" /> evidence</span>
              <span><i className="legend-dot poison" /> untrusted</span>
            </div>
          </div>

          <div className={`memory-inspector inspector-${selectedMemory.kind}`}>
            <div className="inspector-topline">
              <span>{selectedMemory.id}</span>
              <span>{selectedMemory.kind === "poison" && resolved ? "QUARANTINED" : "SELECTED MEMORY"}</span>
            </div>
            <div className="inspector-body">
              <div>
                <strong>{selectedMemory.label}</strong>
                <p>{selectedMemory.detail}</p>
              </div>
              <div className="trust-meter">
                <span>TRUST</span>
                <strong>{selectedMemory.trust}</strong>
                <div><i style={{ width: `${selectedMemory.trust}%` }} /></div>
              </div>
            </div>
            <div className="provenance-row">
              <span>PROVENANCE</span>
              <code>
                {selectedMemory.kind === "poison"
                  ? "bot-import / unsigned / 12d old"
                  : selectedMemory.kind === "policy"
                    ? "security-policy / signed / v7"
                    : "postmortem / human-verified / immutable"}
              </code>
            </div>
          </div>
        </section>

        <aside className="action-panel panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">03 / ACTION GATE</span>
              <h2>What happens next</h2>
            </div>
            <span className={`gate-chip ${resolved ? "safe" : conflictVisible ? "blocked" : ""}`}>
              {resolved ? "VERIFIED" : conflictVisible ? "BLOCKED" : "ARMED"}
            </span>
          </div>

          {!resolved ? (
            <>
              <div className={`plan-card ${conflictVisible ? "has-conflict" : ""}`}>
                <div className="plan-heading">
                  <span>PROPOSED PLAN</span>
                  <span>v1 / branch main</span>
                </div>
                <ol className="plan-list">
                  <li>
                    <span>01</span>
                    <p>Freeze canary traffic at 10%</p>
                    <em>reversible</em>
                  </li>
                  <li className={conflictVisible ? "unsafe" : ""}>
                    <span>02</span>
                    <p>Temporarily bypass JWT signature checks</p>
                    <em>{conflictVisible ? "policy breach" : "unverified"}</em>
                  </li>
                  <li>
                    <span>03</span>
                    <p>Rotate gateway signing key</p>
                    <em>approval</em>
                  </li>
                </ol>
              </div>

              {conflictVisible ? (
                <div className="conflict-card" role="alert">
                  <div className="conflict-icon">!</div>
                  <div>
                    <span className="eyebrow">MEMORY COLLISION</span>
                    <strong>Unsafe recall changed the plan.</strong>
                    <p>
                      M-211 conflicts with signed policy P-07 and has no human
                      provenance. No action was executed.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="preflight-card">
                  <div className="preflight-row">
                    <span>Typed actions</span>
                    <strong>3</strong>
                  </div>
                  <div className="preflight-row">
                    <span>Irreversible actions</span>
                    <strong>0</strong>
                  </div>
                  <div className="preflight-row">
                    <span>Human approvals</span>
                    <strong>1</strong>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="resolved-stack">
              <div className="branch-header">
                <div>
                  <span className="eyebrow">TRUSTED BRANCH</span>
                  <strong>replay / 0427-safe</strong>
                </div>
                <span>4 actions</span>
              </div>
              <div className="safe-actions">
                {safeActions.map(([number, action, guard, state]) => (
                  <div className="safe-action" key={number}>
                    <span>{number}</span>
                    <div>
                      <strong>{action}</strong>
                      <small>{guard}</small>
                    </div>
                    <i className={state} aria-label={state === "approval" ? "Approval required" : "Ready"}>
                      {state === "approval" ? "H" : "✓"}
                    </i>
                  </div>
                ))}
              </div>
              <div className="replay-result">
                <div>
                  <span>UNSAFE ACTIONS</span>
                  <strong><s>2</s> 0</strong>
                </div>
                <div>
                  <span>PLAN CONFIDENCE</span>
                  <strong>61 → 96</strong>
                </div>
              </div>
            </div>
          )}

          <div className="action-footer">
            <PhaseButton
              phase={phase}
              onRun={runTrace}
              onQuarantine={quarantineAndReplay}
              onReset={resetDemo}
            />
            <p>
              {resolved
                ? "Replay sealed. Every decision can be reproduced from its memory snapshot."
                : "Lattice cannot execute side effects until memory provenance clears the action gate."}
            </p>
          </div>
        </aside>
      </section>

      <footer className="audit-rail">
        <div className="audit-title">
          <span className="eyebrow">IMMUTABLE TRACE</span>
          <strong>evt_0427_f3a9</strong>
        </div>
        <div className="audit-steps">
          <div className="audit-step done">
            <i>1</i><span>Signal captured</span><small>09:42:18.213</small>
          </div>
          <div className={`audit-step ${traceActive ? "done" : ""}`}>
            <i>2</i><span>Memory retrieved</span><small>{traceActive ? "43ms" : "—"}</small>
          </div>
          <div className={`audit-step ${conflictVisible || resolved ? "warn" : ""}`}>
            <i>3</i><span>Conflict checked</span><small>{conflictVisible || resolved ? "1 found" : "—"}</small>
          </div>
          <div className={`audit-step ${resolved ? "done" : ""}`}>
            <i>4</i><span>Branch replayed</span><small>{resolved ? "verified" : "—"}</small>
          </div>
          <div className={`audit-step ${resolved ? "done" : ""}`}>
            <i>5</i><span>Evidence sealed</span><small>{resolved ? "s3 / a8c2…" : "—"}</small>
          </div>
        </div>
        <div className="audit-tech">
          <span>CRDB TXN</span>
          <strong>SERIALIZABLE</strong>
        </div>
      </footer>
    </main>
  );
}
