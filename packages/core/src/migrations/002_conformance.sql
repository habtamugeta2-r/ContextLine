-- Blueprint A conformance: covering backward index, event scope, artifact ownership,
-- and a dedicated quarantine manifest. Metadata only; identifiers may be personal data.

-- Part 2: the hot backward lookup can be answered from the index alone.
CREATE INDEX dependencies_backward_covering ON dependencies(tenant_id, artifact_id, artifact_version) INCLUDE (source_id, source_version);
DROP INDEX dependencies_by_artifact;

-- Part 0 B1: principal-scoped events must not delete shared derivatives.
ALTER TABLE artifacts ADD COLUMN owner_principal text CHECK (owner_principal IS NULL OR length(owner_principal) BETWEEN 1 AND 512);
CREATE INDEX artifacts_owner ON artifacts(tenant_id, owner_principal, artifact_type) WHERE owner_principal IS NOT NULL;
ALTER TABLE lifecycle_events ADD COLUMN scope text NOT NULL DEFAULT 'source_wide' CHECK (scope IN ('principal','source_wide'));
UPDATE lifecycle_events SET scope='principal' WHERE event_type IN ('permission_revoked','permission_granted');

-- Part 0 A7 / Part 2 table 5: backfill manifest, written from a background buffer.
CREATE TABLE quarantine_manifest (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 512),
  artifact_version integer NOT NULL CHECK (artifact_version > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, artifact_id, artifact_version)
);
CREATE INDEX quarantine_open ON quarantine_manifest(tenant_id, last_seen_at DESC) WHERE resolved_at IS NULL;
ALTER TABLE quarantine_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quarantine_manifest
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), ''));

-- Blueprint A Part 0 A1/A2: the hot backward lookup must be ONE round-trip AND keep RLS.
-- A `set_config` CTE does not work: PostgreSQL evaluates the RLS qual as a one-time
-- filter before the CTE executes, so the read returns zero rows. A SECURITY INVOKER
-- function sets the GUC first, then runs the query under the caller's own policies.
-- `search_path FROM CURRENT` captures the migration's schema, so custom schemas work.
CREATE FUNCTION lookup_artifacts(p_tenant text, p_ids text[], p_versions integer[])
RETURNS TABLE (
  artifact_id text, version integer, artifact_type text, connector_id text, storage_ref text,
  tenant_id text, status text, owner_principal text, created_at timestamptz, updated_at timestamptz,
  source_id text, source_version integer, source_status text, is_current boolean
)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  IF p_tenant IS NULL OR length(p_tenant) = 0 THEN
    RAISE EXCEPTION 'tenant is required' USING ERRCODE = '22004';
  END IF;
  IF cardinality(p_ids) <> cardinality(p_versions) THEN
    RAISE EXCEPTION 'artifact ids and versions must be parallel arrays' USING ERRCODE = '2202E';
  END IF;
  PERFORM set_config('app.current_tenant', p_tenant, true);
  RETURN QUERY
    SELECT a.artifact_id, a.version, a.artifact_type, a.connector_id, a.storage_ref,
           a.tenant_id, a.status, a.owner_principal, a.created_at, a.updated_at,
           s.source_id, s.version, s.status, s.is_current
    FROM artifacts a
    LEFT JOIN dependencies d ON d.tenant_id = a.tenant_id AND d.artifact_id = a.artifact_id AND d.artifact_version = a.version
    LEFT JOIN sources s ON s.tenant_id = d.tenant_id AND s.source_id = d.source_id AND s.version = d.source_version
    WHERE a.tenant_id = p_tenant
      AND (a.artifact_id, a.version) IN (SELECT x.id, x.v FROM unnest(p_ids, p_versions) AS x(id, v))
    ORDER BY a.artifact_id, a.version, s.source_id;
END $$;
REVOKE ALL ON FUNCTION lookup_artifacts(text, text[], integer[]) FROM PUBLIC;
