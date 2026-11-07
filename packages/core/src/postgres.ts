import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { ContextLineError, artifactKey, artifactRef, boundedArray, identifier, sourceRef, uniqueBy, validateEvent, validateRegistration, version } from './validation.js';
import type { AccessDecision, ArtifactDependencies, ArtifactRecord, ArtifactRef, LifecycleEventRecord, LifecycleJob, RegisterDerivationInput, RegistryStore, Run, SourceEventInput, SourceRef, SourceState } from './types.js';

export type Pool = pg.Pool;
export type PoolConfig = pg.PoolConfig;
export const createPool = (config: PoolConfig): Pool => new pg.Pool(config);
const iso = (value: Date | string): string => new Date(value).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

export class PostgresRegistry implements RegistryStore {
  readonly schema: string;
  constructor(readonly pool: Pool, options: { schema?: string } = {}) {
    this.schema = options.schema ?? 'contextline';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema)) throw new ContextLineError('INVALID_SCHEMA', 'Schema must be a lowercase SQL identifier');
  }
  private table(name: string): string {
    if (!['sources','artifacts','dependencies','lifecycle_events','lifecycle_jobs','access_runs','access_decisions'].includes(name)) throw new Error('Invalid internal table');
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

  async registerDerivation(input: RegisterDerivationInput): Promise<void> {
    validateRegistration(input);
    if (input.run) this.validateRunShape(input.run, input.tenantId);
    await this.transaction(input.tenantId, async c => {
      if (input.run) await this.requireRun(c, input.run);
      const roots = new Map(input.sources.map(s => [s.id, sourceRef(s)]));
      const parents = uniqueBy((input.derivedFrom ?? []).map(artifactRef), artifactKey);
      for (const parent of parents) {
        const result = await c.query(`SELECT source_id, source_version FROM ${this.table('dependencies')} WHERE tenant_id=$1 AND artifact_id=$2 AND artifact_version=$3`, [input.tenantId, parent.id, parent.version]);
        if (!result.rowCount) throw new ContextLineError('UNKNOWN_PARENT', 'Every derivedFrom artifact must have registered root provenance');
        for (const row of result.rows) {
          const root = { id: row.source_id as string, version: row.source_version as number };
          const previous = roots.get(root.id);
          if (previous && previous.version !== root.version) throw new ContextLineError('AMBIGUOUS_SOURCE', 'Conflicting root source versions');
          roots.set(root.id, root);
        }
      }
      const sources = [...roots.values()].sort((a,b) => a.id.localeCompare(b.id) || a.version - b.version);
      boundedArray(sources, 'resolved root sources', 100);
      const sourceRows = await c.query(`SELECT source_id, version, status, is_current FROM ${this.table('sources')} WHERE tenant_id=$1 AND (source_id,version) IN (${sources.map((_,i) => `($${2+i*2},$${3+i*2})`).join(',')}) ORDER BY source_id, version FOR SHARE`, [input.tenantId, ...sources.flatMap(s => [s.id, s.version])]);
      if (sourceRows.rowCount !== sources.length) throw new ContextLineError('UNKNOWN_SOURCE', 'Register sources before registering derivatives');
      for (const a of input.artifacts) {
        const ref = artifactRef(a);
        if (parents.some(p => p.id === ref.id && p.version === ref.version)) throw new ContextLineError('DEPENDENCY_CYCLE', 'An artifact cannot derive from itself');
        await c.query(`INSERT INTO ${this.table('artifacts')} (tenant_id,artifact_id,version,artifact_type,connector_id,storage_ref) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [input.tenantId, ref.id, ref.version, a.type, a.connectorId, a.storageRef]);
        const existing = await c.query(`SELECT artifact_type,connector_id,storage_ref FROM ${this.table('artifacts')} WHERE tenant_id=$1 AND artifact_id=$2 AND version=$3`, [input.tenantId, ref.id, ref.version]);
        if (!existing.rowCount) throw new ContextLineError('CONCURRENT_REGISTRATION', 'Artifact registration raced another transaction; retry the operation');
        const row = existing.rows[0];
        if (row.artifact_type !== a.type || row.connector_id !== a.connectorId || row.storage_ref !== a.storageRef) throw new ContextLineError('IMMUTABLE_ARTIFACT', 'An artifact version cannot change type, connector, or storage reference');
        const previous = await c.query(`SELECT source_id,source_version FROM ${this.table('dependencies')} WHERE tenant_id=$1 AND artifact_id=$2 AND artifact_version=$3`, [input.tenantId, ref.id, ref.version]);
        const previousKeys = new Set(previous.rows.map(r => `${r.source_id}:${r.source_version}`));
        if (previousKeys.size && (previousKeys.size !== sources.length || sources.some(s => !previousKeys.has(`${s.id}:${s.version}`)))) throw new ContextLineError('IMMUTABLE_PROVENANCE', 'An artifact version cannot silently change its root sources; register a new version');
        // Exact retries remain no-ops, but a new artifact cannot appear after a source lifecycle snapshot.
        if (!previousKeys.size && sourceRows.rows.some(s => s.status !== 'active' || !s.is_current)) throw new ContextLineError('SOURCE_UNAVAILABLE', 'New artifacts must reference active, current source versions; historical imports require a separate reviewed workflow');
        for (const s of sources) await c.query(`INSERT INTO ${this.table('dependencies')} (tenant_id,artifact_id,artifact_version,source_id,source_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [input.tenantId, ref.id, ref.version, s.id, s.version]);
      }
    });
  }

  async lookupArtifacts(tenantId: string, refs: { id: string; version: number }[]): Promise<ArtifactDependencies[]> {
    identifier(tenantId, 'tenant ID'); boundedArray(refs, 'artifact lookups', 100); refs.forEach(artifactRef);
    const unique = uniqueBy(refs, artifactKey);
    return this.transaction(tenantId, async c => {
      const params: unknown[] = [tenantId];
      const tuples = unique.map(r => { params.push(r.id, r.version); return `($${params.length-1},$${params.length})`; });
      const result = await c.query(`SELECT a.artifact_id,a.version,a.artifact_type,a.connector_id,a.storage_ref,a.tenant_id,a.status,a.created_at,a.updated_at,
        s.source_id,s.version AS source_version,s.status AS source_status,s.is_current
        FROM ${this.table('artifacts')} a
        LEFT JOIN ${this.table('dependencies')} d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.artifact_id AND d.artifact_version=a.version
        LEFT JOIN ${this.table('sources')} s ON s.tenant_id=d.tenant_id AND s.source_id=d.source_id AND s.version=d.source_version
        WHERE a.tenant_id=$1 AND (a.artifact_id,a.version) IN (${tuples.join(',')}) ORDER BY a.artifact_id,a.version,s.source_id`, params);
      const found = new Map<string, ArtifactDependencies>();
      for (const row of result.rows) {
        const key = artifactKey({ id: row.artifact_id, version: row.version });
        if (!found.has(key)) found.set(key, { artifact: {
          id: row.artifact_id, version: row.version, type: row.artifact_type, connectorId: row.connector_id,
          storageRef: row.storage_ref, tenantId: row.tenant_id, status: row.status,
          createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
        }, sources: [] });
        if (row.source_id) found.get(key)!.sources.push({ id: row.source_id, version: row.source_version, status: row.source_status, isCurrent: row.is_current });
      }
      return [...found.values()];
    });
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
      const authorizationOnly = ['permission_revoked','permission_granted'].includes(input.event);
      if (input.event === 'document_updated') {
        if (input.newVersion !== sourceVersion + 1) throw new ContextLineError('INVALID_VERSION', 'newVersion must be exactly current version + 1');
        await c.query(`UPDATE ${this.table('sources')} SET is_current=false,updated_at=now() WHERE tenant_id=$1 AND source_id=$2 AND version=$3`, [input.tenantId,input.sourceId,sourceVersion]);
        await c.query(`INSERT INTO ${this.table('sources')} (tenant_id,source_id,version) VALUES ($1,$2,$3)`, [input.tenantId,input.sourceId,input.newVersion]);
      } else if (['document_deleted','gdpr_erasure_requested','retention_expired','source_restricted','source_reactivated'].includes(input.event)) {
        const status = input.event === 'source_restricted' ? 'revoked' : input.event === 'retention_expired' ? 'expired' : input.event === 'source_reactivated' ? 'active' : 'deleted';
        await c.query(`UPDATE ${this.table('sources')} SET status=$3,updated_at=now() WHERE tenant_id=$1 AND source_id=$2`, [input.tenantId,input.sourceId,status]);
      }
      const details = { propagation: authorizationOnly ? 'authorization_only' : 'storage', newVersion: input.newVersion ?? null, memoryAction: input.memoryAction ?? 'flag' };
      const result = await c.query(`INSERT INTO ${this.table('lifecycle_events')} (tenant_id,event_id,source_id,source_version,event_type,affected_principals,idempotency_key,request_fingerprint,details,status,completed_at) VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9::jsonb,$10,$11) RETURNING *`, [input.tenantId,randomUUID(),input.sourceId,sourceVersion,input.event,principals,input.idempotencyKey ?? null,fingerprint,json(details),authorizationOnly?'completed':'pending',authorizationOnly?new Date():null]);
      return this.mapEvent(result.rows[0]);
    });
  }
  mapEvent(row: Record<string, any>): LifecycleEventRecord {
    return { id: row.event_id, tenantId: row.tenant_id, sourceId: row.source_id, sourceVersion: row.source_version, eventType: row.event_type, affectedPrincipals: row.affected_principals, affectedArtifacts: row.affected_artifacts, processedArtifacts: row.processed_artifacts, status: row.status, jobsReady: row.jobs_ready, details: row.details, createdAt: iso(row.created_at), startedAt: row.started_at ? iso(row.started_at) : null, completedAt: row.completed_at ? iso(row.completed_at) : null };
  }
  mapJob(row: Record<string, any>): LifecycleJob {
    return { id: row.job_id, eventId: row.event_id, tenantId: row.tenant_id, artifactId: row.artifact_id, artifactVersion: row.artifact_version, artifactType: row.artifact_type, connectorId: row.connector_id, storageRef: row.storage_ref, action: row.action, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, nextAttemptAt: iso(row.next_attempt_at), leaseUntil: row.lease_until ? iso(row.lease_until) : null, leaseToken: row.lease_token, lastErrorCode: row.last_error_code, verifiedAt: row.verified_at ? iso(row.verified_at) : null, history: row.history };
  }

  /** Serialize the event snapshot against registration's source FOR SHARE locks. */
  async materializeNextEvent(tenantId: string, maxAttempts = 6): Promise<LifecycleEventRecord | null> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new ContextLineError('INVALID_CONFIG', 'maxAttempts must be 1–20');
    return this.transaction(tenantId, async c => {
      const claim = await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND NOT jobs_ready AND status='pending' ORDER BY CASE WHEN event_type IN ('gdpr_erasure_requested','document_deleted') THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [tenantId]);
      if (!claim.rowCount) return null;
      const event = this.mapEvent(claim.rows[0]);
      await c.query(`SELECT version FROM ${this.table('sources')} WHERE tenant_id=$1 AND source_id=$2 ORDER BY version FOR UPDATE`, [tenantId,event.sourceId]);
      const action = ['document_deleted','gdpr_erasure_requested','retention_expired'].includes(event.eventType) ? 'delete' : event.eventType === 'source_restricted' && event.details.memoryAction === 'delete' ? 'delete' : 'invalidate';
      await c.query(`INSERT INTO ${this.table('lifecycle_jobs')} (tenant_id,job_id,event_id,artifact_id,artifact_version,action,max_attempts)
        SELECT $1,gen_random_uuid(),$2,a.artifact_id,a.version,CASE WHEN $5='delete' THEN 'delete' WHEN a.artifact_type='memory' AND $6='flag' THEN 'flag' ELSE $5 END,$4
        FROM ${this.table('dependencies')} d JOIN ${this.table('artifacts')} a ON a.tenant_id=d.tenant_id AND a.artifact_id=d.artifact_id AND a.version=d.artifact_version
        WHERE d.tenant_id=$1 AND d.source_id=$3 AND ($5='delete' OR $8 OR d.source_version=$7) AND a.status <> 'deleted'
        ON CONFLICT DO NOTHING`, [tenantId,event.id,event.sourceId,maxAttempts,action,event.details.memoryAction ?? 'flag',event.sourceVersion,event.eventType === 'source_restricted']);
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
    const total = Object.values(counts).reduce((a,b) => a+b,0);
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
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 AND event_id=$2::uuid`, [tenantId,eventId]);
      return result.rowCount ? this.mapEvent(result.rows[0]) : null;
    });
  }
  async listEvents(tenantId: string, limit = 50): Promise<LifecycleEventRecord[]> {
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT * FROM ${this.table('lifecycle_events')} WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [tenantId,Math.min(100,Math.max(1,limit))]);
      return result.rows.map(r => this.mapEvent(r));
    });
  }
  async listJobs(tenantId: string, eventId?: string): Promise<LifecycleJob[]> {
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT j.*,a.artifact_type,a.connector_id,a.storage_ref FROM ${this.table('lifecycle_jobs')} j JOIN ${this.table('artifacts')} a ON a.tenant_id=j.tenant_id AND a.artifact_id=j.artifact_id AND a.version=j.artifact_version WHERE j.tenant_id=$1 AND ($2::uuid IS NULL OR j.event_id=$2::uuid) ORDER BY j.created_at,j.artifact_id LIMIT 1000`, [tenantId,eventId ?? null]);
      return result.rows.map(r => this.mapJob(r));
    });
  }
  async listSources(tenantId: string): Promise<(SourceState & { updatedAt: string })[]> {
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT * FROM ${this.table('sources')} WHERE tenant_id=$1 ORDER BY source_id,version`, [tenantId]);
      return result.rows.map(r => ({ id:r.source_id,version:r.version,status:r.status,isCurrent:r.is_current,updatedAt:iso(r.updated_at) }));
    });
  }
  async listArtifacts(tenantId: string): Promise<(ArtifactRecord & { sources: SourceRef[] })[]> {
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT a.*,coalesce(jsonb_agg(jsonb_build_object('id',d.source_id,'version',d.source_version) ORDER BY d.source_id) FILTER (WHERE d.source_id IS NOT NULL),'[]') AS sources FROM ${this.table('artifacts')} a LEFT JOIN ${this.table('dependencies')} d ON d.tenant_id=a.tenant_id AND d.artifact_id=a.artifact_id AND d.artifact_version=a.version WHERE a.tenant_id=$1 GROUP BY a.tenant_id,a.artifact_id,a.version ORDER BY a.artifact_id LIMIT 1000`, [tenantId]);
      return result.rows.map(r => ({ id:r.artifact_id,version:r.version,type:r.artifact_type,connectorId:r.connector_id,storageRef:r.storage_ref,tenantId:r.tenant_id,status:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),sources:r.sources }));
    });
  }
  async listDecisions(tenantId: string, runId?: string): Promise<(AccessDecision & { runId: string; principal: string; createdAt: string; durationMs: number })[]> {
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT d.*,r.principal FROM ${this.table('access_decisions')} d JOIN ${this.table('access_runs')} r ON r.tenant_id=d.tenant_id AND r.run_id=d.run_id WHERE d.tenant_id=$1 AND ($2::uuid IS NULL OR d.run_id=$2::uuid) ORDER BY d.created_at DESC,d.artifact_id LIMIT 200`, [tenantId,runId ?? null]);
      return result.rows.map(r => ({ runId:r.run_id,principal:r.principal,artifactId:r.artifact_id,artifactVersion:r.artifact_version,allowed:r.allowed,outcome:r.outcome,reason:r.reason,sources:r.source_refs,createdAt:iso(r.created_at),durationMs:Number(r.duration_ms) }));
    });
  }
  async queueStats(tenantId: string): Promise<{ pending: number; failed: number; review: number }> {
    return this.transaction(tenantId, async c => {
      const result = await c.query(`SELECT count(*) FILTER (WHERE status IN ('pending','processing','retry'))::int AS pending,count(*) FILTER (WHERE status='failed')::int AS failed,count(*) FILTER (WHERE status='pending_review')::int AS review FROM ${this.table('lifecycle_jobs')} WHERE tenant_id=$1`,[tenantId]);
      return result.rows[0];
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
    for (const table of ['sources','artifacts','dependencies','lifecycle_events','lifecycle_jobs','access_runs','access_decisions']) {
      const privileges = ['sources','artifacts','lifecycle_events','lifecycle_jobs'].includes(table) ? 'SELECT,INSERT,UPDATE' : 'SELECT,INSERT';
      await client.query(`GRANT ${privileges} ON "${schema}"."${table}" TO "${role}"`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
