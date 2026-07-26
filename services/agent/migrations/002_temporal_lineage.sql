ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS decision_hlc DECIMAL NULL;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS decision_wall_time TIMESTAMPTZ NULL;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL;

ALTER TABLE memory_reads
  ADD COLUMN IF NOT EXISTS cohort_agreement FLOAT8 NULL;

ALTER TABLE memory_reads
  ADD COLUMN IF NOT EXISTS semantic_anomaly FLOAT8 NULL;

ALTER TABLE memory_events
  ADD COLUMN IF NOT EXISTS run_id UUID NULL;

ALTER TABLE memory_events
  ADD COLUMN IF NOT EXISTS branch_name STRING NULL;

CREATE TABLE IF NOT EXISTS memory_interventions (
  workspace_id STRING NOT NULL,
  run_id UUID NOT NULL,
  memory_id STRING NOT NULL,
  state STRING NOT NULL,
  actor STRING NOT NULL,
  reason STRING NOT NULL,
  evidence_hash STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, memory_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, id),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories (workspace_id, id),
  CONSTRAINT valid_intervention_state
    CHECK (state IN ('quarantined', 'restored'))
);

CREATE TABLE IF NOT EXISTS human_approvals (
  workspace_id STRING NOT NULL,
  run_id UUID NOT NULL,
  decision STRING NOT NULL,
  actor STRING NOT NULL,
  plan_hash STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, id),
  CONSTRAINT valid_approval_decision
    CHECK (decision IN ('approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS interventions_by_memory
  ON memory_interventions (workspace_id, memory_id, created_at DESC);
