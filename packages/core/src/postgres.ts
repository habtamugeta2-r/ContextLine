import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { ContextLineError, artifactKey, artifactRef, boundedArray, identifier, sourceRef, uniqueBy, validateEvent, validateRegistration, version } from './validation.js';
import { eventScope, lifecycleActionFor } from './policy.js';
import type { AccessDecision, ArtifactDependencies, ArtifactRecord, ArtifactRef, ArtifactType, LifecycleAction, LifecycleEventRecord, LifecycleJob, QuarantineEntry, QuarantineHit, RegisterDerivationInput, RegistryStore, Run, SourceEventInput, SourceRef, SourceState } from './types.js';

export type Pool = pg.Pool;
export type PoolConfig = pg.PoolConfig;
export const createPool = (config: PoolConfig): Pool => new pg.Pool(config);
const iso = (value: Date | string): string => new Date(value).toISOString();
const json = (value: unknown): string => JSON.stringify(value);
const CORE_TABLES = ['sources','artifacts','dependencies','lifecycle_events','lifecycle_jobs','access_runs','access_decisions','quarantine_manifest'] as const;
const ARTIFACT_TYPES: ArtifactType[] = ['embedding','cache','summary','memory','other'];
/** Blueprint A Part 0 A3: registration batches are ingestion-sized, not chunk-sized. */
export const MAX_REGISTRATION_ARTIFACTS = 500;

export class PostgresRegistry implements RegistryStore {
  readonly schema: string;
  constructor(readonly pool: Pool, options: { schema?: string } = {}) {
    this.schema = options.schema ?? 'contextline';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema)) throw new ContextLineError('INVALID_SCHEMA', 'Schema must be a lowercase SQL identifier');
  }
  private table(name: string): string {
    if (!(CORE_TABLES as readonly string[]).includes(name)) throw new Error('Invalid internal table');
    return `"${this.schema}"."${name}"`;
  }
  async transaction<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    identifier(tenantId, 'tenant ID');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined); throw error;
    } finally { client.release(); }
  }
  /**
   * Cold reads (UI, audit, operator tooling) use a transaction-local tenant setting.
   * The hot retrieval path uses the `lookup_artifacts` SQL function instead, which is
   * one round-trip; see migration 002 for why a set_config CTE cannot work under RLS.
   */
  private async read<T = Record<string, any>>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T[]>): Promise<T[]> {
    return this.transaction(tenantId, fn);
  }
  async healthCheck(): Promise<void> { await this.pool.query('SELECT 1'); }

  async ensureSource(tenantId: string, ref: SourceRef): Promise<void> {
    sourceRef(ref);
    await this.transaction(tenantId, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([tenantId,ref.id])]);
      const inserted = await c.query(`INSERT INTO ${this.table('sources')} (tenant_id, source_id, version) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_id`, [tenantId, ref.id, ref.version]);
      if (inserted.rowCount) {
        if (ref.version !== 1) throw new ContextLineError('INVALID_VERSION', 'A new source starts at version 1; use document_updated for subsequent versions');
        return;
      }
      const existing = await c.query(`SELECT 1 FROM ${this.table('sources')} WHERE tenant_id=$1 AND source_id=$2 AND version=$3`, [tenantId, ref.id, ref.version]);
      if (!existing.rowCount) throw new ContextLineError('SOURCE_VERSION', 'Source exists at another version; use document_updated');
    });
  }

  /**
   * Set-based registration: at most three bulk writes (optional sources, artifacts,
   * dependencies) regardless of batch size, plus two set-based reads. Immutable identity,
   * tombstones and the revocation race are all checked inside the same transaction.
   */
  async registerDerivation(input: RegisterDerivationInput): Promise<void> {
    validateRegistration(input);
    if (input.run) this.validateRunShape(input.run, input.tenantId);
    await this.transaction(input.tenantId, async c => {
      if (input.run) await this.requireRun(c, input.run);
      const roots = new Map(input.sources.map(s => [s.id, sourceRef(s)]));
      const parents = uniqueBy((input.derivedFrom ?? []).map(artifactRef), artifactKey);
      if (parents.length) {
        const params: unknown[] = [input.tenantId];
        const tuples = parents.map(p => { params.push(p.id, p.version); return `($${params.length-1},$${params.length})`; });
        const rows = await c.query(`SELECT artifact_id,artifact_version,source_id,source_version FROM ${this.table('dependencies')} WHERE tenant_id=$1 AND (artifact_id,artifact_version) IN (${tuples.join(',')})`, params);
        const seen = new Set<string>();
        for (const row of rows.rows) {
          seen.add(artifactKey({ id: row.artifact_id, version: row.artifact_version }));
          const root = { id: row.source_id as string, version: row.source_version as number };
          const previous = roots.get(root.id);
          if (previous && previous.version !== root.version) throw new ContextLineError('AMBIGUOUS_SOURCE', 'Conflicting root source versions');
          roots.set(root.id, root);
        }
        for (const parent of parents) if (!seen.has(artifactKey(parent))) throw new ContextLineError('UNKNOWN_PARENT', 'Every derivedFrom artifact must have registered root provenance');
      }
      const sources = [...roots.values()].sort((a,b) => a.id.localeCompare(b.id) || a.version - b.version);
      boundedArray(sources, 'resolved root sources', 100);
      for (const a of input.artifacts) {
        if (parents.some(p => p.id === a.id && (p.version ?? 1) === (a.version ?? 1))) throw new ContextLineError('DEPENDENCY_CYCLE', 'An artifact cannot derive from itself');
      }
      // Bulk write 1 (optional): create only brand-new version-1 sources. Never reactivate.
      if (input.createSources) {
        const fresh = sources.filter(s => s.version === 1);
        if (fresh.length) await c.query(`INSERT INTO ${this.table('sources')} (tenant_id,source_id,version) SELECT $1,s.id,1 FROM unnest($2::text[]) AS s(id) ON CONFLICT DO NOTHING`, [input.tenantId, fresh.map(s => s.id)]);
      }
      const sourceParams: unknown[] = [input.tenantId];
      const sourceTuples = sources.map(s => { sourceParams.push(s.id, s.version); return `($${sourceParams.length-1},$${sourceParams.length})`; });
      const sourceRows = await c.query(`SELECT source_id, version, status, is_current FROM ${this.table('sources')} WHERE tenant_id=$1 AND (source_id,version) IN (${sourceTuples.join(',')}) ORDER BY source_id, version FOR SHARE`, sourceParams);
      if (sourceRows.rowCount !== sources.length) throw new ContextLineError('UNKNOWN_SOURCE', 'Register sources before registering derivatives, or pass createSources');
      const refs = input.artifacts.map(a => artifactRef(a));
      // Bulk write 2: one set-based insert for the whole batch.
      await c.query(`INSERT INTO ${this.table('artifacts')} (tenant_id,artifact_id,version,artifact_type,connector_id,storage_ref,owner_principal)
        SELECT $1,a.id,a.version,a.type,a.connector,a.storage_ref,a.owner
        FROM unnest($2::text[],$3::int[],$4::text[],$5::text[],$6::text[],$7::text[]) AS a(id,version,type,connector,storage_ref,owner)
        ON CONFLICT (tenant_id,artifact_id,version) DO NOTHING`, [
        input.tenantId, refs.map(r => r.id), refs.map(r => r.version), input.artifacts.map(a => a.type),
        input.artifacts.map(a => a.connectorId), input.artifacts.map(a => a.storageRef), input.artifacts.map(a => a.ownerPrincipal ?? null),
      ]);
      const existingParams: unknown[] = [input.tenantId];
      const existingTuples = refs.map(r => { existingParams.push(r.id, r.version); return `($${existingParams.length-1},$${existingParams.length})`; });
      const existing = await c.query(`SELECT a.artifact_id,a.version,a.artifact_type,a.connector_id,a.storage_ref,a.owner_principal,
          coalesce(jsonb_agg(jsonb_build_object('id',d.source_id,'version',d.source_version) ORDER BY d.source_id) FILTER (WHERE d.source_id IS NOT NULL),'[]') AS sources
        FROM ${this.table('artifacts')} a LEFT JOIN ${this.table('dependencies')} d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.artifact_id AND d.artifact_version=a.version
        WHERE a.tenant_id=$1 AND (a.artifact_id,a.version) IN (${existingTuples.join(',')}) GROUP BY a.tenant_id,a.artifact_id,a.version`, existingParams);
      if (existing.rowCount !== refs.length) throw new ContextLineError('CONCURRENT_REGISTRATION', 'Artifact registration raced another transaction; retry the operation');
      const byKey = new Map<string, any>(existing.rows.map(r => [artifactKey({ id: r.artifact_id, version: r.version }), r]));
      const sourceUnavailable = sourceRows.rows.some(s => s.status !== 'active' || !s.is_current);
      const edgeArtifacts: string[] = [], edgeVersions: number[] = [], edgeSources: string[] = [], edgeSourceVersions: number[] = [];
      for (const [index,a] of input.artifacts.entries()) {
        const ref = refs[index]!;
        const row = byKey.get(artifactKey(ref));
        if (row.artifact_type !== a.type || row.connector_id !== a.connectorId || row.storage_ref !== a.storageRef || (row.owner_principal ?? null) !== (a.ownerPrincipal ?? null)) {
          throw new ContextLineError('IMMUTABLE_ARTIFACT', 'An artifact version cannot change type, connector, storage reference, or owner');
        }
        const previous = row.sources as SourceRef[];
        if (previous.length) {
          // Exact retry of a committed registration, including after deletion: a no-op.
          if (previous.length !== sources.length || sources.some(s => !previous.some(p => p.id === s.id && p.version === s.version))) {
            throw new ContextLineError('IMMUTABLE_PROVENANCE', 'An artifact version cannot silently change its root sources; register a new version');
          }
          continue;
        }
        // Blueprint A Part 0 B3: a source revoked mid-flight blocks the new artifact.
        if (sourceUnavailable) throw new ContextLineError('SOURCE_UNAVAILABLE', 'New artifacts must reference active, current source versions; historical imports require a separate reviewed workflow');
        for (const s of sources) { edgeArtifacts.push(ref.id); edgeVersions.push(ref.version); edgeSources.push(s.id); edgeSourceVersions.push(s.version); }
      }
      // Bulk write 3: the whole cross-product in one statement.
      if (edgeArtifacts.length) await c.query(`INSERT INTO ${this.table('dependencies')} (tenant_id,artifact_id,artifact_version,source_id,source_version)
        SELECT $1,e.aid,e.av,e.sid,e.sv FROM unnest($2::text[],$3::int[],$4::text[],$5::int[]) AS e(aid,av,sid,sv) ON CONFLICT DO NOTHING`,
      [input.tenantId, edgeArtifacts, edgeVersions, edgeSources, edgeSourceVersions]);
    });
  }

  /**
   * Blueprint A Part 0 A1: ONE batched backward lookup, ONE network round-trip.
   * The SQL function sets the tenant GUC before scanning, so RLS still applies and a
   * pooled connection never carries another tenant's context. Explicit tenant
   * predicates inside the function mean a GUC failure can only under-return rows.
   */
  async lookupArtifacts(tenantId: string, refs: { id: string; version: number }[]): Promise<ArtifactDependencies[]> {
    identifier(tenantId, 'tenant ID'); boundedArray(refs, 'artifact lookups', 100); refs.forEach(artifactRef);
    const unique = uniqueBy(refs, artifactKey);
    const result = await this.pool.query(`SELECT * FROM "${this.schema}".lookup_artifacts($1,$2::text[],$3::integer[])`, [tenantId, unique.map(r => r.id), unique.map(r => r.version)]);
    const found = new Map<string, ArtifactDependencies>();
    for (const row of result.rows) {
      const key = artifactKey({ id: row.artifact_id, version: row.version });
      if (!found.has(key)) found.set(key, { artifact: {
        id: row.artifact_id, version: row.version, type: row.artifact_type, connectorId: row.connector_id,
        storageRef: row.storage_ref, tenantId: row.tenant_id, status: row.status, ownerPrincipal: row.owner_principal ?? null,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      }, sources: [] });
      if (row.source_id) found.get(key)!.sources.push({ id: row.source_id, version: row.source_version, status: row.source_status, isCurrent: row.is_current });
    }
    return [...found.values()];
  }

  private validateRunShape(run: Run, tenantId?: string): void {
    identifier(run.tenantId, 'tenant ID'); identifier(run.principal, 'principal');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(run.id)) throw new ContextLineError('INVALID_RUN', 'Invalid run ID');
    if (tenantId && run.tenantId !== tenantId) throw new ContextLineError('TENANT_MISMATCH', 'Run and operation tenant must match');
  }
  private async requireRun(c: pg.PoolClient, run: Run): Promise<void> {
    this.validateRunShape(run, run.tenantId);
    const result = await c.query(`SELECT 1 FROM ${this.table('access_runs')} WHERE tenant_id=$1 AND run_id=$2 AND principal=$3`, [run.tenantId, run.id, run.principal]);
    if (!result.rowCount) throw new ContextLineError('INVALID_RUN', 'Run does not exist for this tenant and principal');
  }
  async beginRun(tenantId: string, principal: string): Promise<Run> {
    identifier(principal, 'principal');
    const run = { id: randomUUID(), tenantId, principal };
    await this.transaction(tenantId, async c => { await c.query(`INSERT INTO ${this.table('access_runs')} (tenant_id,run_id,principal) VALUES ($1,$2,$3)`, [tenantId, run.id, principal]); });
    return run;
  }
  async recordDecisions(run: Run, decisions: AccessDecision[], durationMs: number): Promise<void> {
    boundedArray(decisions, 'decisions', 100, true);
    await this.transaction(run.tenantId, async c => {
      await this.requireRun(c, run);
      if (decisions.length) {
        const params: unknown[] = [];
        const tuples = decisions.map(d => {
          const offset = params.length;
          params.push(run.tenantId, randomUUID(), run.id, d.artifactId, d.artifactVersion, d.allowed, d.outcome, d.reason, json(d.sources), durationMs);
          return `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9}::jsonb,$${offset+10})`;
        });
        await c.query(`INSERT INTO ${this.table('access_decisions')} (tenant_id,decision_id,run_id,artifact_id,artifact_version,allowed,outcome,reason,source_refs,duration_ms) VALUES ${tuples.join(',')}`, params);
      }
    });
  }

  async recordSourceEvent(input: SourceEventInput): Promise<LifecycleEventRecord> {
    validateEvent(input);
    const principals = [...new Set(input.affectedPrincipals ?? [])].sort();
    const scope = eventScope(input.event);
    const fingerprint = createHash('sha256').update(json({ sourceId: input.sourceId, event: input.event, principals, newVersion: input.newVersion ?? null, memoryAction: input.memoryAction ?? 'flag' })).digest('hex');
    return this.transaction(input.tenantId, async c => {
      // Same lock order as registration, avoiding shared/exclusive lock-order deadlocks.
      await c.query(`SELECT version FROM ${this.table('sources')} WHERE tenant_id=$1 AND source_id=$2 ORDER BY version FOR UPDATE`, [input.tenantId,input.sourceId]);
      const current = await c.query(`SELECT version FROM ${this.table('sources')} WHERE tenant_id=$1 AND source_id=$2 AND is_current FOR UPDATE`, [input.tenantId, input.sourceId]);
      if (!current.rowCount) throw new ContextLineError('UNKNOWN_SOURCE', 'Cannot record an event for an unknown source');
      if (input.idempotencyKey) {
        const prior = await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND idempotency_key=$2`, [input.tenantId, input.idempotencyKey]);
        if (prior.rowCount) {
          if (prior.rows[0].request_fingerprint !== fingerprint) throw new ContextLineError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different event');
          return this.mapEvent(prior.rows[0]);
        }
      }
      const sourceVersion: number = current.rows[0].version;
      const auditOnly = ['permission_granted','source_reactivated'].includes(input.event);
      if (input.event === 'document_updated') {
        if (input.newVersion !== sourceVersion + 1) throw new ContextLineError('INVALID_VERSION', 'newVersion must be exactly current version + 1');
        await c.query(`UPDATE ${this.table('sources')} SET is_current=false,updated_at=now() WHERE tenant_id=$1 AND source_id=$2 AND version=$3`, [input.tenantId,input.sourceId,sourceVersion]);
        await c.query(`INSERT INTO ${this.table('sources')} (tenant_id,source_id,version) VALUES ($1,$2,$3)`, [input.tenantId,input.sourceId,input.newVersion]);
      } else if (['document_deleted','gdpr_erasure_requested','retention_expired','source_restricted','source_reactivated'].includes(input.event)) {
        const status = input.event === 'source_restricted' ? 'revoked' : input.event === 'retention_expired' ? 'expired' : input.event === 'source_reactivated' ? 'active' : 'deleted';
        await c.query(`UPDATE ${this.table('sources')} SET status=$3,updated_at=now() WHERE tenant_id=$1 AND source_id=$2`, [input.tenantId,input.sourceId,status]);
      }
      const details = { propagation: auditOnly || scope === 'principal' && input.event === 'permission_granted' ? 'authorization_only' : 'storage', newVersion: input.newVersion ?? null, memoryAction: input.memoryAction ?? 'flag' };
      const result = await c.query(`INSERT INTO ${this.table('lifecycle_events')} (tenant_id,event_id,source_id,source_version,event_type,scope,affected_principals,idempotency_key,request_fingerprint,details,status,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10::jsonb,$11,$12) RETURNING *`, [input.tenantId,randomUUID(),input.sourceId,sourceVersion,input.event,scope,principals,input.idempotencyKey ?? null,fingerprint,json(details),auditOnly?'completed':'pending',auditOnly?new Date():null]);
      return this.mapEvent(result.rows[0]);
    });
  }
  mapEvent(row: Record<string, any>): LifecycleEventRecord {
    return { id: row.event_id, tenantId: row.tenant_id, sourceId: row.source_id, sourceVersion: row.source_version, eventType: row.event_type, scope: row.scope ?? eventScope(row.event_type), affectedPrincipals: row.affected_principals, affectedArtifacts: row.affected_artifacts, processedArtifacts: row.processed_artifacts, status: row.status, jobsReady: row.jobs_ready, details: row.details, createdAt: iso(row.created_at), startedAt: row.started_at ? iso(row.started_at) : null, completedAt: row.completed_at ? iso(row.completed_at) : null };
  }
  mapJob(row: Record<string, any>): LifecycleJob {
    return { id: row.job_id, eventId: row.event_id, tenantId: row.tenant_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, artifactType: row.artifact_type, connectorId: row.connector_id, storageRef: row.storage_ref, action: row.action, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, nextAttemptAt: iso(row.next_attempt_at), leaseUntil: row.lease_until ? iso(row.lease_until) : null, leaseToken: row.lease_token, lastErrorCode: row.last_error_code, verifiedAt: row.verified_at ? iso(row.verified_at) : null, history: row.history };
  }

  /** Serialize the event snapshot against registration's source FOR SHARE locks. */
  async materializeNextEvent(tenantId: string, maxAttempts = 6): Promise<LifecycleEventRecord | null> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new ContextLineError('INVALID_CONFIG', 'maxAttempts must be 1–20');
    return this.transaction(tenantId, async c => {
      const claim = await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND NOT jobs_ready AND status='pending'
        ORDER BY CASE WHEN event_type IN ('gdpr_erasure_requested','source_restricted','permission_revoked') THEN 0 WHEN event_type IN ('document_deleted','retention_expired') THEN 1 ELSE 2 END,created_at
        FOR UPDATE SKIP LOCKED LIMIT 1`, [tenantId]);
      if (!claim.rowCount) return null;
      const event = this.mapEvent(claim.rows[0]);
      await c.query(`SELECT version FROM ${this.table('sources')} WHERE tenant_id=$1 AND source_id=$2 ORDER BY version FOR UPDATE`, [tenantId,event.sourceId]);
      const memoryAction: LifecycleAction = event.details.memoryAction as LifecycleAction ?? 'flag';
      const actions = ARTIFACT_TYPES.map(type => lifecycleActionFor(event.eventType, type, memoryAction));
      const principalScoped = event.scope === 'principal';
      const allVersions = event.eventType !== 'document_updated';
      await c.query(`INSERT INTO ${this.table('lifecycle_jobs')} (tenant_id,job_id,event_id,artifact_id,artifact_version,action,max_attempts)
        SELECT $1,gen_random_uuid(),$2,a.artifact_id,a.version,
          CASE a.artifact_type WHEN 'embedding' THEN $5 WHEN 'cache' THEN $6 WHEN 'summary' THEN $7 WHEN 'memory' THEN $8 ELSE $9 END,$4
        FROM ${this.table('dependencies')} d JOIN ${this.table('artifacts')} a ON a.tenant_id=d.tenant_id AND a.artifact_id=d.artifact_id AND a.version=d.artifact_version
        WHERE d.tenant_id=$1 AND d.source_id=$3 AND ($10 OR d.source_version=$11) AND a.status <> 'deleted'
          AND CASE a.artifact_type WHEN 'embedding' THEN $5 WHEN 'cache' THEN $6 WHEN 'summary' THEN $7 WHEN 'memory' THEN $8 ELSE $9 END IS NOT NULL
          AND (NOT $12::boolean OR (a.status='active' AND a.artifact_type IN ('cache','memory') AND a.owner_principal = ANY($13::text[])))
        ON CONFLICT DO NOTHING`, [tenantId,event.id,event.sourceId,maxAttempts,actions[0],actions[1],actions[2],actions[3],actions[4],allVersions,event.sourceVersion,principalScoped,event.affectedPrincipals]);
      const count = await c.query(`SELECT count(*)::int AS n FROM ${this.table('lifecycle_jobs')} WHERE tenant_id=$1 AND event_id=$2`, [tenantId,event.id]);
      const n: number = count.rows[0].n;
      const result = await c.query(`UPDATE ${this.table('lifecycle_events')} SET jobs_ready=true,affected_artifacts=$3,processed_artifacts=0,status=$4,started_at=now(),completed_at=$5 WHERE tenant_id=$1 AND event_id=$2 RETURNING *`, [tenantId,event.id,n,n?'processing':'completed',n?null:new Date()]);
      return this.mapEvent(result.rows[0]);
    });
  }
  async claimJobs(tenantId: string, limit: number, leaseMs: number): Promise<LifecycleJob[]> {
    boundedArray(new Array(Math.max(0, limit)), 'job limit', 100, true);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new ContextLineError('INVALID_CONFIG', 'leaseMs must be 1000–3600000');
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT j.*,a.artifact_type,a.connector_id,a.storage_ref FROM ${this.table('lifecycle_jobs')} j JOIN ${this.table('artifacts')} a ON a.tenant_id=j.tenant_id AND a.artifact_id=j.artifact_id AND a.version=j.artifact_version
        WHERE j.tenant_id=$1 AND ((j.status IN ('pending','retry') AND j.next_attempt_at<=now()) OR (j.status='processing' AND j.lease_until<now()))
        ORDER BY j.next_attempt_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT $2`, [tenantId,limit]);
      const jobs: LifecycleJob[] = [];
      for (const row of result.rows) {
        const token = randomUUID();
        const updated = await c.query(`UPDATE ${this.table('lifecycle_jobs')} SET status='processing',attempts=attempts+1,lease_token=$3::uuid,lease_until=now()+($4::double precision * interval '1 millisecond'),updated_at=now() WHERE tenant_id=$1 AND job_id=$2 RETURNING *`, [tenantId,row.job_id,token,leaseMs]);
        jobs.push(this.mapJob({ ...updated.rows[0], artifact_type: row.artifact_type, connector_id: row.connector_id, storage_ref: row.storage_ref }));
      }
      return jobs;
    });
  }
  /** Blueprint A Part 5: extend the lease while work is genuinely in flight. */
  async heartbeatJob(job: LifecycleJob, leaseMs: number): Promise<boolean> {
    return this.transaction(job.tenantId, async c => {
      const result = await c.query(`UPDATE ${this.table('lifecycle_jobs')} SET lease_until=now()+($4::double precision * interval '1 millisecond'),updated_at=now()
        WHERE tenant_id=$1 AND job_id=$2::uuid AND lease_token=$3::uuid AND status='processing' RETURNING job_id`,
      [job.tenantId,job.id,job.leaseToken,leaseMs]);
      return (result.rowCount ?? 0) > 0;
    });
  }
  async finishJob(job: LifecycleJob, result: { status: 'completed' | 'pending_review' | 'retry' | 'failed'; errorCode?: string | undefined; verified?: boolean | undefined; delayMs?: number | undefined }): Promise<boolean> {
    return this.transaction(job.tenantId, async c => {
      const existing = await c.query(`SELECT * FROM ${this.table('lifecycle_jobs')} WHERE tenant_id=$1 AND job_id=$2 AND lease_token=$3::uuid AND status='processing' FOR UPDATE`, [job.tenantId,job.id,job.leaseToken]);
      if (!existing.rowCount) return false;
      const current = existing.rows[0];
      const terminal = result.status === 'completed' || result.status === 'pending_review';
      if (terminal) {
        const status = result.status === 'completed' ? job.action === 'delete' ? 'deleted' : job.action === 'invalidate' ? 'stale' : 'pending_review' : 'pending_review';
        await c.query(`UPDATE ${this.table('artifacts')} SET status=CASE WHEN status='deleted' THEN 'deleted' ELSE $3 END,updated_at=now() WHERE tenant_id=$1 AND artifact_id=$2 AND version=$4`, [job.tenantId,job.artifactId,status,job.artifactVersion]);
      }
      const history = [...current.history, { attempt: current.attempts, at: new Date().toISOString(), status: result.status, errorCode: result.errorCode ?? null, verified: result.verified ?? false }].slice(-20);
      await c.query(`UPDATE ${this.table('lifecycle_jobs')} SET status=$3,last_error_code=$4,verified_at=$5,lease_token=NULL,lease_until=NULL,next_attempt_at=now()+($6::double precision * interval '1 millisecond'),history=$7::jsonb,updated_at=now() WHERE tenant_id=$1 AND job_id=$2`, [job.tenantId,job.id,result.status,result.errorCode ?? null,result.verified ? new Date() : null,result.delayMs ?? 0,json(history)]);
      await this.refreshEvent(c, job.tenantId, job.eventId);
      return true;
    });
  }
  private async refreshEvent(c: pg.PoolClient, tenantId: string, eventId: string): Promise<void> {
    // Serialize aggregate refreshes for one event. Without this row lock, two jobs can
    // finish concurrently and the last committer can publish a stale processing snapshot.
    await c.query(`SELECT 1 FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND event_id=$2::uuid FOR UPDATE`, [tenantId,eventId]);
    const result = await c.query(`SELECT status,count(*)::int AS n FROM ${this.table('lifecycle_jobs')} WHERE tenant_id=$1 AND event_id=$2 GROUP BY status`, [tenantId,eventId]);
    const counts: Record<string,number> = Object.fromEntries(result.rows.map(r => [r.status,r.n]));
    const processed = (counts.completed ?? 0)+(counts.pending_review ?? 0)+(counts.failed ?? 0);
    const unfinished = (counts.pending ?? 0)+(counts.processing ?? 0)+(counts.retry ?? 0);
    const status = unfinished ? (counts.failed || counts.pending_review ? 'partial' : 'processing') : counts.failed ? 'failed' : counts.pending_review ? 'partial' : 'completed';
    await c.query(`UPDATE ${this.table('lifecycle_events')} SET status=$3,processed_artifacts=$4,details=details || $5::jsonb,completed_at=$6 WHERE tenant_id=$1 AND event_id=$2`, [tenantId,eventId,status,processed,json({ results: counts }),unfinished?null:new Date()]);
  }
  async retryEvent(tenantId: string, eventId: string): Promise<number> {
    identifier(eventId, 'event ID');
    return this.transaction(tenantId, async c => {
      const event = await c.query(`SELECT 1 FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND event_id=$2::uuid FOR UPDATE`, [tenantId,eventId]);
      if (!event.rowCount) throw new ContextLineError('NOT_FOUND', 'Lifecycle event not found');
      const reset = await c.query(`UPDATE ${this.table('lifecycle_jobs')} SET status='pending',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND event_id=$2::uuid AND status='failed' RETURNING job_id`, [tenantId,eventId]);
      if (reset.rowCount) await c.query(`UPDATE ${this.table('lifecycle_events')} SET status='processing',completed_at=NULL,details=details || jsonb_build_object('retryRequestedAt',now()) WHERE tenant_id=$1 AND event_id=$2::uuid`, [tenantId,eventId]);
      return reset.rowCount ?? 0;
    });
  }
  /** Acknowledge a flagged derivative while keeping it blocked; never restores serving. */
  async acknowledgeReview(tenantId: string, jobId: string, reviewer: string): Promise<boolean> {
    identifier(jobId,'job ID'); identifier(reviewer,'reviewer');
    return this.transaction(tenantId,async c => {
      const result=await c.query(`SELECT * FROM ${this.table('lifecycle_jobs')} WHERE tenant_id=$1 AND job_id=$2::uuid AND status='pending_review' AND action='flag' FOR UPDATE`,[tenantId,jobId]);
      if(!result.rowCount)return false;
      const job=result.rows[0];
      const history=[...job.history,{at:new Date().toISOString(),status:'review_acknowledged',reviewer,artifactRemainsBlocked:true}];
      await c.query(`UPDATE ${this.table('lifecycle_jobs')} SET status='completed',history=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND job_id=$2::uuid`,[tenantId,jobId,json(history)]);
      await this.refreshEvent(c,tenantId,job.event_id);
      return true;
    });
  }
  async getEvent(tenantId: string, eventId: string): Promise<LifecycleEventRecord | null> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND event_id=$2::uuid`, [tenantId,eventId])).rows);
    return rows.length ? this.mapEvent(rows[0]!) : null;
  }
  async listEvents(tenantId: string, limit = 50): Promise<LifecycleEventRecord[]> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [tenantId,Math.min(100,Math.max(1,limit))])).rows);
    return rows.map(r => this.mapEvent(r));
  }
  async listJobs(tenantId: string, eventId?: string): Promise<LifecycleJob[]> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT j.*,a.artifact_type,a.connector_id,a.storage_ref FROM ${this.table('lifecycle_jobs')} j JOIN ${this.table('artifacts')} a ON a.tenant_id=j.tenant_id AND a.artifact_id=j.artifact_id AND a.version=j.artifact_version WHERE j.tenant_id=$1 AND ($2::uuid IS NULL OR j.event_id=$2::uuid) ORDER BY j.created_at,j.artifact_id LIMIT 1000`, [tenantId,eventId ?? null])).rows);
    return rows.map(r => this.mapJob(r));
  }
  async listSources(tenantId: string): Promise<(SourceState & { updatedAt: string })[]> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT * FROM ${this.table('sources')} WHERE tenant_id=$1 ORDER BY source_id,version`, [tenantId])).rows);
    return rows.map(r => ({ id:r.source_id,version:r.version,status:r.status,isCurrent:r.is_current,updatedAt:iso(r.updated_at) }));
  }
  async listArtifacts(tenantId: string): Promise<(ArtifactRecord & { sources: SourceRef[] })[]> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT a.*,coalesce(jsonb_agg(jsonb_build_object('id',d.source_id,'version',d.source_version) ORDER BY d.source_id) FILTER (WHERE d.source_id IS NOT NULL),'[]') AS sources FROM ${this.table('artifacts')} a LEFT JOIN ${this.table('dependencies')} d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.artifact_id AND d.artifact_version=a.version WHERE a.tenant_id=$1 GROUP BY a.tenant_id,a.artifact_id,a.version ORDER BY a.artifact_id LIMIT 1000`, [tenantId])).rows);
    return rows.map(r => ({ id:r.artifact_id,version:r.version,type:r.artifact_type,connectorId:r.connector_id,storageRef:r.storage_ref,tenantId:r.tenant_id,status:r.status,ownerPrincipal:r.owner_principal ?? null,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),sources:r.sources }));
  }
  async listDecisions(tenantId: string, runId?: string): Promise<(AccessDecision & { runId: string; principal: string; createdAt: string; durationMs: number })[]> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT d.*,r.principal FROM ${this.table('access_decisions')} d JOIN ${this.table('access_runs')} r ON r.tenant_id=d.tenant_id AND r.run_id=d.run_id WHERE d.tenant_id=$1 AND ($2::uuid IS NULL OR d.run_id=$2::uuid) ORDER BY d.created_at DESC,d.artifact_id LIMIT 200`, [tenantId,runId ?? null])).rows);
    return rows.map(r => ({ runId:r.run_id,principal:r.principal,artifactId:r.artifact_id,artifactVersion:r.artifact_version,allowed:r.allowed,outcome:r.outcome,reason:r.reason,sources:r.source_refs,createdAt:iso(r.created_at),durationMs:Number(r.duration_ms) }));
  }
  async queueStats(tenantId: string): Promise<{ pending: number; failed: number; review: number }> {
    const rows = await this.read<{ pending:number; failed:number; review:number }>(tenantId, async c => (await c.query(`SELECT count(*) FILTER (WHERE status IN ('pending','processing','retry'))::int AS pending,count(*) FILTER (WHERE status='failed')::int AS failed,count(*) FILTER (WHERE status='pending_review')::int AS review FROM ${this.table('lifecycle_jobs')} WHERE tenant_id=$1`,[tenantId])).rows);
    return rows[0] ?? { pending:0,failed:0,review:0 };
  }
  /** Blueprint A Part 0 A7: flushed from the SDK's background buffer, never per request. */
  async recordQuarantineHits(tenantId: string, hits: QuarantineHit[]): Promise<void> {
    boundedArray(hits, 'quarantine hits', 1000, true);
    if (!hits.length) return;
    await this.transaction(tenantId, async c => {
      await c.query(`INSERT INTO ${this.table('quarantine_manifest')} AS q (tenant_id,artifact_id,artifact_version,occurrence_count)
        SELECT $1,h.id,h.version,h.n FROM unnest($2::text[],$3::int[],$4::bigint[]) AS h(id,version,n)
        ON CONFLICT (tenant_id,artifact_id,artifact_version) DO UPDATE SET last_seen_at=now(),occurrence_count=q.occurrence_count+EXCLUDED.occurrence_count,resolved_at=NULL`,
      [tenantId, hits.map(h => h.artifactId), hits.map(h => h.artifactVersion), hits.map(h => h.count ?? 1)]);
    });
  }
  async listQuarantine(tenantId: string, includeResolved = false): Promise<QuarantineEntry[]> {
    const rows = await this.read(tenantId, async c => (await c.query(`SELECT * FROM ${this.table('quarantine_manifest')} WHERE tenant_id=$1 AND ($2::boolean OR resolved_at IS NULL) ORDER BY occurrence_count DESC,last_seen_at DESC LIMIT 1000`, [tenantId,includeResolved])).rows);
    return rows.map(r => ({ artifactId:r.artifact_id,artifactVersion:r.artifact_version,firstSeenAt:iso(r.first_seen_at),lastSeenAt:iso(r.last_seen_at),occurrenceCount:Number(r.occurrence_count),resolvedAt:r.resolved_at?iso(r.resolved_at):null }));
  }
  async resolveQuarantine(tenantId: string, refs: ArtifactRef[]): Promise<number> {
    boundedArray(refs, 'quarantine references', 1000);
    const resolved = refs.map(artifactRef);
    return this.transaction(tenantId, async c => {
      const result = await c.query(`UPDATE ${this.table('quarantine_manifest')} q SET resolved_at=now() FROM unnest($2::text[],$3::int[]) AS r(id,version) WHERE q.tenant_id=$1 AND q.artifact_id=r.id AND q.artifact_version=r.version AND q.resolved_at IS NULL`, [tenantId,resolved.map(r => r.id),resolved.map(r => r.version)]);
      return result.rowCount ?? 0;
    });
  }
  metricsText(tenantId: string, values: { processed: number; failures: number; claimed: number }): string {
    const t = tenantId.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n');
    return `# TYPE contextline_jobs_processed_total counter\ncontextline_jobs_processed_total{tenant="${t}"} ${values.processed}\n# TYPE contextline_job_failures_total counter\ncontextline_job_failures_total{tenant="${t}"} ${values.failures}\n# TYPE contextline_jobs_claimed_total counter\ncontextline_jobs_claimed_total{tenant="${t}"} ${values.claimed}\n`;
  }
}

export async function migrateRegistry(pool: Pool, options: { schema?: string } = {}): Promise<void> {
  const schema = options.schema ?? 'contextline';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new ContextLineError('INVALID_SCHEMA', 'Invalid schema name');
  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(f => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
  if (!files.length) throw new ContextLineError('MISSING_MIGRATIONS', 'No migration assets found; run the package build');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_lock(724190117)');
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file]);
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum) throw new ContextLineError('MIGRATION_CHANGED', 'An applied migration has changed; add a new migration instead');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)', [file,checksum]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally {
    await client.query('SELECT pg_advisory_unlock(724190117)').catch(() => undefined);
    client.release();
  }
}

export async function grantRuntimeRole(pool: Pool, role: string, schema = 'contextline'): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new ContextLineError('INVALID_IDENTIFIER', 'Invalid role or schema');
  const client = await pool.connect();
  try {
    const check = await client.query('SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1', [role]);
    if (!check.rowCount || check.rows[0].rolsuper || check.rows[0].rolbypassrls || !check.rows[0].rolcanlogin) throw new ContextLineError('UNSAFE_ROLE', 'Runtime role must exist with LOGIN, NOSUPERUSER, NOBYPASSRLS');
    const owner = await client.query('SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2', [schema,'sources']);
    if (owner.rows[0]?.owner === role) throw new ContextLineError('UNSAFE_ROLE', 'Runtime role must not own the registry tables');
    await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    for (const table of CORE_TABLES) {
      const privileges = ['sources','artifacts','lifecycle_events','lifecycle_jobs','quarantine_manifest'].includes(table) ? 'SELECT,INSERT,UPDATE' : 'SELECT,INSERT';
      await client.query(`GRANT ${privileges} ON "${schema}"."${table}" TO "${role}"`);
    }
    await client.query(`GRANT EXECUTE ON FUNCTION "${schema}".lookup_artifacts(text,text[],integer[]) TO "${role}"`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
