CREATE TABLE IF NOT EXISTS incidents (
  workspace_id STRING NOT NULL,
  id STRING NOT NULL,
  title STRING NOT NULL,
  severity STRING NOT NULL,
  region STRING NOT NULL,
  status STRING NOT NULL DEFAULT 'open',
  summary STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS memories (
  workspace_id STRING NOT NULL,
  id STRING NOT NULL,
  kind STRING NOT NULL,
  title STRING NOT NULL,
  content STRING NOT NULL,
  trust_score INT NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  provenance JSONB NOT NULL,
  signature_status STRING NOT NULL,
  status STRING NOT NULL DEFAULT 'active',
  supersedes_id STRING NULL,
  embedding VECTOR(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  quarantined_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT valid_memory_kind CHECK (kind IN ('evidence', 'memory', 'policy')),
  CONSTRAINT valid_memory_status CHECK (status IN ('active', 'superseded', 'quarantined'))
);

CREATE VECTOR INDEX IF NOT EXISTS memory_embedding_idx
  ON memories (workspace_id, embedding vector_cosine_ops)
  WITH (min_partition_size = 16, max_partition_size = 128);

CREATE TABLE IF NOT EXISTS agent_runs (
  workspace_id STRING NOT NULL,
  id UUID NOT NULL,
  incident_id STRING NOT NULL,
  phase STRING NOT NULL,
  branch_name STRING NOT NULL,
  plan JSONB NOT NULL,
  conflict_count INT NOT NULL DEFAULT 0,
  idempotency_key STRING NOT NULL,
  skill_receipts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, incident_id)
    REFERENCES incidents (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS memory_reads (
  workspace_id STRING NOT NULL,
  run_id UUID NOT NULL,
  memory_id STRING NOT NULL,
  rank INT NOT NULL,
  similarity FLOAT8 NOT NULL,
  decision STRING NOT NULL,
  guardrail_result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, memory_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, id),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS memory_events (
  workspace_id STRING NOT NULL,
  id UUID NOT NULL,
  memory_id STRING NOT NULL,
  event_type STRING NOT NULL,
  actor STRING NOT NULL,
  reason STRING NOT NULL,
  evidence_hash STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS action_journal (
  workspace_id STRING NOT NULL,
  id UUID NOT NULL,
  run_id UUID NOT NULL,
  action_key STRING NOT NULL,
  state STRING NOT NULL,
  input_hash STRING NOT NULL,
  result JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, run_id, action_key),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS runs_by_incident
  ON agent_runs (workspace_id, incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_events_by_memory
  ON memory_events (workspace_id, memory_id, created_at DESC);
