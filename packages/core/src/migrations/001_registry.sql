-- ContextLine 0.1. PostgreSQL >=15. Metadata only; identifiers may be personal data.
-- The migration runner owns this schema. Runtime must use a non-owner, NOBYPASSRLS role.
CREATE TABLE sources (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 512),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','deleted','expired')),
  is_current boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id, version)
);
CREATE UNIQUE INDEX sources_one_current ON sources(tenant_id, source_id) WHERE is_current;
CREATE INDEX sources_tenant_status ON sources(tenant_id, status);

CREATE TABLE artifacts (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 512),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  artifact_type text NOT NULL CHECK (artifact_type IN ('embedding','cache','summary','memory','other')),
  connector_id text NOT NULL CHECK (connector_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  storage_ref text NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 1024),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','deleted','pending_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, artifact_id, version)
);
CREATE INDEX artifacts_tenant_type ON artifacts(tenant_id, artifact_type, status);

CREATE TABLE dependencies (
  tenant_id text NOT NULL,
  artifact_id text NOT NULL,
  artifact_version integer NOT NULL,
  source_id text NOT NULL,
  source_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, artifact_id, artifact_version, source_id, source_version),
  FOREIGN KEY (tenant_id, artifact_id, artifact_version) REFERENCES artifacts(tenant_id, artifact_id, version),
  FOREIGN KEY (tenant_id, source_id, source_version) REFERENCES sources(tenant_id, source_id, version)
);
CREATE INDEX dependencies_by_source ON dependencies(tenant_id, source_id, source_version, artifact_id, artifact_version);
CREATE INDEX dependencies_by_artifact ON dependencies(tenant_id, artifact_id, artifact_version);

CREATE TABLE lifecycle_events (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  source_id text NOT NULL,
  source_version integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('permission_revoked','permission_granted','document_updated','document_deleted','retention_expired','gdpr_erasure_requested','source_restricted','source_reactivated')),
  affected_principals text[] NOT NULL DEFAULT '{}',
  affected_artifacts integer NOT NULL DEFAULT 0 CHECK (affected_artifacts >= 0),
  processed_artifacts integer NOT NULL DEFAULT 0 CHECK (processed_artifacts >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','partial','failed')),
  jobs_ready boolean NOT NULL DEFAULT false,
  idempotency_key text,
  request_fingerprint text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, source_id, source_version) REFERENCES sources(tenant_id, source_id, version),
  CHECK (event_type NOT IN ('permission_revoked','permission_granted') OR cardinality(affected_principals) > 0)
);
CREATE INDEX events_claim ON lifecycle_events(status, created_at) WHERE status IN ('pending','processing','partial','failed');
CREATE INDEX events_source ON lifecycle_events(tenant_id, source_id, created_at DESC);
CREATE INDEX events_tenant ON lifecycle_events(tenant_id, created_at DESC);

CREATE TABLE lifecycle_jobs (
  tenant_id text NOT NULL,
  job_id uuid NOT NULL,
  event_id uuid NOT NULL,
  artifact_id text NOT NULL,
  artifact_version integer NOT NULL,
  action text NOT NULL CHECK (action IN ('delete','invalidate','flag')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','retry','completed','pending_review','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error_code text,
  verified_at timestamptz,
  history jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, event_id, artifact_id, artifact_version),
  FOREIGN KEY (tenant_id, event_id) REFERENCES lifecycle_events(tenant_id, event_id),
  FOREIGN KEY (tenant_id, artifact_id, artifact_version) REFERENCES artifacts(tenant_id, artifact_id, version)
);
CREATE INDEX jobs_claim ON lifecycle_jobs(next_attempt_at, status) WHERE status IN ('pending','retry','processing');
CREATE INDEX jobs_event ON lifecycle_jobs(tenant_id, event_id, status);
CREATE INDEX jobs_dead_letter ON lifecycle_jobs(tenant_id, updated_at) WHERE status IN ('failed','pending_review');

CREATE TABLE access_runs (
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  principal text NOT NULL CHECK (length(principal) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id)
);
CREATE TABLE access_decisions (
  tenant_id text NOT NULL,
  decision_id uuid NOT NULL,
  run_id uuid NOT NULL,
  artifact_id text NOT NULL,
  artifact_version integer NOT NULL,
  allowed boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied','skipped')),
  reason text NOT NULL,
  source_refs jsonb NOT NULL,
  duration_ms numeric NOT NULL CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, decision_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES access_runs(tenant_id, run_id)
);
CREATE INDEX decisions_run ON access_decisions(tenant_id, run_id, created_at);
CREATE INDEX decisions_artifact ON access_decisions(tenant_id, artifact_id, created_at DESC);
CREATE INDEX decisions_review ON access_decisions(tenant_id, created_at DESC) WHERE reason IN ('unregistered','quarantined');

-- BOTH visibility and writes are constrained. Missing GUC => no rows.
-- FORCE is necessary for owners, but superusers/BYPASSRLS still bypass policies.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sources','artifacts','dependencies','lifecycle_events','lifecycle_jobs','access_runs','access_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.current_tenant'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.current_tenant'', true), ''''))', t);
  END LOOP;
END $$;
