import { performance } from 'node:perf_hooks';
import { ContextLineError, artifactKey, artifactRef, boundedArray, identifier, sourceRef, uniqueBy, validateEnforcement, validateRegistration } from './validation.js';
import type { AuthCacheOptions, QuarantineHit, AccessDecision, ArtifactDependencies, ArtifactRef, AuthorizationCallback, AuthorizedArtifact, DecisionReason, Diagnostic, EnforcementOptions, RegisterDerivationInput, RegistryStore, Run, SourceEventInput, SourceRef } from './types.js';

export interface ContextLineOptions {
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Required by default: an unauditable allow decision is blocked. */
  auditPolicy?: 'required' | 'best_effort';
  /** Off by default. Allow-only, TTL hard-capped at 30s. */
  authCache?: AuthCacheOptions;
  /** Background quarantine flush; never on the request path. */
  quarantineFlush?: { intervalMs?: number; maxItems?: number };
}
interface Candidate { artifactId: string; artifactVersion?: number | undefined }
const denyReasons: Record<string, DecisionReason> = { deleted:'artifact_deleted', stale:'artifact_stale', pending_review:'artifact_pending_review' };
const sourceReasons: Record<string, DecisionReason> = { deleted:'source_deleted', revoked:'source_revoked', expired:'source_expired' };

/** Blueprint A Part 3 step 5, literal form: one timed call per unique source, in parallel. */
async function perSourceAuthorization(callback: AuthorizationCallback, request: { tenantId: string; principal: string }, sources: SourceRef[], timeoutMs: number): Promise<Map<string, boolean>> {
  const results = await Promise.all(sources.map(async source => {
    const decision = await authorizationBatch(callback,{ ...request,sources:[source] },timeoutMs);
    return [source.id, decision.get(source.id) === true] as const;
  }));
  return new Map(results);
}

async function authorizationBatch(callback: AuthorizationCallback, request: { tenantId: string; principal: string; sources: SourceRef[] }, timeoutMs: number): Promise<Map<string, boolean>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ContextLineError('AUTH_TIMEOUT', 'Authorization callback timed out')), timeoutMs); });
    const result = await Promise.race([Promise.resolve().then(() => callback(request)), timeout]);
    const entries = result instanceof Map ? [...result.entries()] : Object.entries(result);
    if (entries.length !== request.sources.length) throw new ContextLineError('AUTH_RESULT', 'Authorization result must contain exactly one entry per requested source');
    const decisions = new Map(entries);
    for (const source of request.sources) if (typeof decisions.get(source.id) !== 'boolean') throw new ContextLineError('AUTH_RESULT', 'Authorization results must be explicit booleans for every requested source');
    return decisions as Map<string, boolean>;
  } finally { if (timer) clearTimeout(timer); }
}

export class ContextLine {
  private readonly auditPolicy: 'required' | 'best_effort';
  private readonly allowCache: AllowCache | null;
  private readonly quarantine = new Map<string, QuarantineHit & { tenantId: string }>();
  private quarantineTimer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly quarantineMax: number;
  constructor(private readonly registry: RegistryStore & { recordQuarantineHits?: (tenantId: string, hits: QuarantineHit[]) => Promise<void> }, private readonly options: ContextLineOptions = {}) {
    this.auditPolicy = options.auditPolicy ?? 'required';
    if (!['required','best_effort'].includes(this.auditPolicy)) throw new ContextLineError('INVALID_POLICY', 'Unknown audit policy');
    this.allowCache = options.authCache?.enabled ? new AllowCache(options.authCache) : null;
    this.quarantineMax = options.quarantineFlush?.maxItems ?? 100;
    const interval = options.quarantineFlush?.intervalMs ?? 5000;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 300000) throw new ContextLineError('INVALID_CONFIG', 'quarantineFlush.intervalMs must be 1–300000');
    if (!Number.isSafeInteger(this.quarantineMax) || this.quarantineMax < 1 || this.quarantineMax > 1000) throw new ContextLineError('INVALID_CONFIG', 'quarantineFlush.maxItems must be 1–1000');
    if (this.registry.recordQuarantineHits) {
      this.quarantineTimer = setInterval(() => { void this.flushQuarantine(); }, interval);
      this.quarantineTimer.unref?.();
    }
  }
  /** Buffer a quarantine hit; the manifest write happens off the request path. */
  private enqueueQuarantine(tenantId: string, artifactId: string, artifactVersion: number): void {
    if (!this.registry.recordQuarantineHits || this.closed) return;
    const key = JSON.stringify([tenantId,artifactId,artifactVersion]);
    const existing = this.quarantine.get(key);
    if (existing) existing.count = (existing.count ?? 1) + 1;
    else this.quarantine.set(key,{ tenantId,artifactId,artifactVersion,count:1 });
    if (this.quarantine.size >= this.quarantineMax) void this.flushQuarantine();
  }
  async flushQuarantine(): Promise<void> {
    if (!this.registry.recordQuarantineHits || !this.quarantine.size) return this.flushing;
    const batch = [...this.quarantine.values()];
    this.quarantine.clear();
    const tenants = new Map<string, QuarantineHit[]>();
    for (const hit of batch) {
      const list = tenants.get(hit.tenantId) ?? [];
      list.push({ artifactId:hit.artifactId,artifactVersion:hit.artifactVersion,count:hit.count ?? 1 });
      tenants.set(hit.tenantId,list);
    }
    this.flushing = this.flushing.then(async () => {
      for (const [tenantId,hits] of tenants) {
        try { await this.registry.recordQuarantineHits!(tenantId,hits); }
        catch { this.diagnostic('QUARANTINE_FLUSH_FAILED','flushQuarantine',tenantId); }
      }
    });
    return this.flushing;
  }
  /** Flush buffers. The caller owns the pool and closes it separately. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.quarantineTimer) clearInterval(this.quarantineTimer);
    this.quarantineTimer = undefined;
    await this.flushQuarantine();
    await this.flushing;
    this.allowCache?.clear();
  }
  private diagnostic(code: string, operation: string, tenantId: string): void {
    // Never pass callback errors, payload content, credentials, or connection strings to logs.
    this.options.onDiagnostic?.({ code, operation, tenantId });
  }
  ensureSource(tenantId: string, source: SourceRef): Promise<void> { return this.registry.ensureSource(tenantId, sourceRef(source)); }
  beginRun(tenantId: string, principal: string): Promise<Run> { return this.registry.beginRun(tenantId, principal); }
  async registerDerivation(input: RegisterDerivationInput): Promise<void> {
    validateRegistration(input);
    if (input.run && input.run.tenantId !== input.tenantId) throw new ContextLineError('TENANT_MISMATCH', 'Run and registration tenant must match');
    await this.registry.registerDerivation(input);
  }
  async recordSourceEvent(input: SourceEventInput) {
    const event = await this.registry.recordSourceEvent(input);
    // Local purge only; cross-instance invalidation is bounded by the cache TTL.
    this.allowCache?.purgeSource(input.tenantId,input.sourceId);
    return event;
  }

  async filterAuthorized<T extends Candidate>(options: EnforcementOptions & { run: Run; candidates: T[] }): Promise<AuthorizedArtifact<T>[]> {
    const started = performance.now();
    validateEnforcement(options); boundedArray(options.candidates, 'candidates', 100, true);
    const run = options.run;
    identifier(run.tenantId, 'tenant ID'); identifier(run.principal, 'principal');
    const refs = options.candidates.map(c => artifactRef({ id:c.artifactId,version:c.artifactVersion }));
    if (new Set(refs.map(artifactKey)).size !== refs.length) throw new ContextLineError('DUPLICATE_CANDIDATE', 'Candidate artifact versions must be unique');
    let records: ArtifactDependencies[];
    try { records = await this.registry.lookupArtifacts(run.tenantId, refs); }
    catch { this.diagnostic('REGISTRY_UNAVAILABLE','filterAuthorized',run.tenantId); return []; }
    const lookup = new Map(records.map(r => [artifactKey(r.artifact),r]));
    const decisions: AccessDecision[] = [];
    const eligible: { artifact: T; record: ArtifactDependencies; ref: { id: string; version: number } }[] = [];
    const preReasons = new Map<string, DecisionReason>();
    for (const [index,candidate] of options.candidates.entries()) {
      const ref = refs[index]!;
      const record = lookup.get(artifactKey(ref));
      let reason: DecisionReason | undefined;
      if (!record) reason = options.unregisteredPolicy === 'quarantine' ? 'quarantined' : options.unregisteredPolicy === 'allow' ? 'unregistered_allow_override' : 'unregistered';
      else if (record.artifact.status !== 'active') reason = denyReasons[record.artifact.status];
      else if (!record.sources.length) reason = 'empty_provenance';
      else {
        for (const source of record.sources) {
          if (source.status !== 'active') { reason = sourceReasons[source.status]; break; }
          if (!source.isCurrent && !options.allowOutdatedVersions) { reason = 'source_outdated'; break; }
        }
        if (!reason) eligible.push({ artifact:candidate,record,ref });
      }
      if (reason) {
        if (reason === 'quarantined') this.enqueueQuarantine(run.tenantId,ref.id,ref.version);
        const allowed = reason === 'unregistered_allow_override';
        decisions.push({ artifactId:ref.id,artifactVersion:ref.version,allowed,outcome:allowed?'allowed':'denied',reason,sources:record?.sources.map(s => ({ id:s.id,version:s.version })) ?? [] });
        if (allowed) eligible.push({ artifact:candidate,ref,record:{ artifact:{ id:ref.id,version:ref.version,type:'other',connectorId:'unregistered',storageRef:'',tenantId:run.tenantId,status:'active',ownerPrincipal:null,createdAt:'',updatedAt:'' },sources:[] } });
        preReasons.set(artifactKey(ref),reason);
      }
    }
    // Deduplicate by source ID, not by chunk. Authorization always concerns the current source.
    const sourceIds = new Map<string, SourceRef>();
    for (const item of eligible) for (const source of item.record.sources) if (!sourceIds.has(source.id)) sourceIds.set(source.id,{ id:source.id,version:source.version });
    const auth = new Map<string,boolean>();
    let authFailure: DecisionReason | undefined;
    if (sourceIds.size) {
      const timeoutMs = options.timeoutMs ?? 500;
      const pending: SourceRef[] = [];
      for (const [id,ref] of sourceIds) {
        // Registry lifecycle state was already checked above, so a cached allow can
        // never resurrect a revoked, deleted, expired, or outdated source.
        if (this.allowCache?.get(run.tenantId,run.principal,id)) auth.set(id,true);
        else pending.push(ref);
      }
      if (pending.length) {
        try {
          const results = options.authorizeMode === 'per-source'
            ? await perSourceAuthorization(options.authorize,{ tenantId:run.tenantId,principal:run.principal },pending,timeoutMs)
            : await authorizationBatch(options.authorize,{ tenantId:run.tenantId,principal:run.principal,sources:pending },timeoutMs);
          for (const [id,allowed] of results) { auth.set(id,allowed); this.allowCache?.set(run.tenantId,run.principal,id,allowed); }
        } catch (error) { authFailure = error instanceof ContextLineError && error.code === 'AUTH_TIMEOUT' ? 'authorization_timeout' : 'authorization_error'; }
      }
    }
    for (const item of eligible) {
      const ref = item.ref;
      if (preReasons.has(artifactKey(ref))) continue;
      const denied = item.record.sources.some(s => auth.get(s.id) !== true);
      const reason: DecisionReason = authFailure ? (options.onError === 'allow' && item.record.sources.length ? 'authorization_allow_override' : authFailure) : denied ? 'authorization_denied' : 'allowed';
      const allowed = reason === 'allowed' || reason === 'authorization_allow_override';
      const skipped = !!authFailure && options.onError === 'skip' && !allowed;
      decisions.push({ artifactId:ref.id,artifactVersion:ref.version,allowed,outcome:allowed?'allowed':skipped?'skipped':'denied',reason,sources:item.record.sources.map(s => ({ id:s.id,version:s.version })) });
    }
    const byKey = new Map(decisions.map(d => [artifactKey({id:d.artifactId,version:d.artifactVersion}),d]));
    const orderedDecisions = refs.map(ref => byKey.get(artifactKey(ref))!);
    try { await this.registry.recordDecisions(run,orderedDecisions,performance.now()-started); }
    catch {
      this.diagnostic('AUDIT_UNAVAILABLE','recordDecisions',run.tenantId);
      if (this.auditPolicy === 'required') return [];
    }
    const allowed = new Map(decisions.filter(d => d.allowed).map(d => [artifactKey({ id:d.artifactId,version:d.artifactVersion }),d.sources]));
    return options.candidates.filter(c => allowed.has(artifactKey({ id:c.artifactId,version:c.artifactVersion }))).map(artifact => ({ artifact,sourceRefs:allowed.get(artifactKey({ id:artifact.artifactId,version:artifact.artifactVersion }))! }));
  }

  async assertCanServe(options: EnforcementOptions & { artifact: ArtifactRef | string; principal: string; tenantId: string; run?: Run | undefined }): Promise<boolean> {
    const ref = typeof options.artifact === 'string' ? { id:options.artifact } : options.artifact;
    if (options.run && (options.run.tenantId !== options.tenantId || options.run.principal !== options.principal)) throw new ContextLineError('TENANT_MISMATCH', 'Run principal and tenant must match the serving request');
    let run: Run;
    try { run = options.run ?? await this.beginRun(options.tenantId,options.principal); }
    catch { this.diagnostic('REGISTRY_UNAVAILABLE','beginRun',options.tenantId); return false; }
    const result = await this.filterAuthorized({ ...options,run,candidates:[{ artifactId:ref.id,artifactVersion:ref.version ?? 1 }] });
    return result.length === 1;
  }
}

/**
 * Blueprint A Part 0 B5: opt-in, allow-only, hard-capped at 30s.
 * A cached allow can never override registry lifecycle state, because artifact/source
 * status and freshness are read from the registry on every call, before this cache.
 */
export class AllowCache {
  private readonly entries = new Map<string,{ value: true; expiresAt: number }>();
  readonly ttlMs: number;
  readonly maxEntries: number;
  constructor(options: AuthCacheOptions = {}) {
    const ttl = options.ttlMs ?? 10000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 30000) throw new ContextLineError('INVALID_CONFIG', 'authCache.ttlMs must be 1–30000 (blueprint cap)');
    this.maxEntries = options.maxEntries ?? 10000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 1000000) throw new ContextLineError('INVALID_CONFIG', 'authCache.maxEntries must be 1–1000000');
    this.ttlMs = ttl;
  }
  private key(tenantId: string, principal: string, sourceId: string): string { return JSON.stringify([tenantId,principal,sourceId]); }
  get(tenantId: string, principal: string, sourceId: string): boolean {
    const key = this.key(tenantId,principal,sourceId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) { this.entries.delete(key); return false; }
    return true;
  }
  set(tenantId: string, principal: string, sourceId: string, allowed: boolean): void {
    if (!allowed) return; // Never cache a denial: a stale deny would over-block.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(this.key(tenantId,principal,sourceId), { value:true, expiresAt: Date.now()+this.ttlMs });
  }
  purgeSource(tenantId: string, sourceId: string): void {
    const suffix = JSON.stringify([sourceId]);
    for (const key of this.entries.keys()) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === tenantId && JSON.stringify([parts[2]]) === suffix) this.entries.delete(key);
    }
  }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
