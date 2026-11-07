import { performance } from 'node:perf_hooks';
import { ContextLineError, artifactKey, artifactRef, boundedArray, identifier, sourceRef, uniqueBy, validateEnforcement, validateRegistration } from './validation.js';
import type { AccessDecision, ArtifactDependencies, ArtifactRef, AuthorizationCallback, AuthorizedArtifact, DecisionReason, Diagnostic, EnforcementOptions, RegisterDerivationInput, RegistryStore, Run, SourceEventInput, SourceRef } from './types.js';

export interface ContextLineOptions {
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Required by default: an unauditable allow decision is blocked. */
  auditPolicy?: 'required' | 'best_effort';
}
interface Candidate { artifactId: string; artifactVersion?: number | undefined }
const denyReasons: Record<string, DecisionReason> = { deleted:'artifact_deleted', stale:'artifact_stale', pending_review:'artifact_pending_review' };
const sourceReasons: Record<string, DecisionReason> = { deleted:'source_deleted', revoked:'source_revoked', expired:'source_expired' };

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
  constructor(private readonly registry: RegistryStore, private readonly options: ContextLineOptions = {}) {
    this.auditPolicy = options.auditPolicy ?? 'required';
    if (!['required','best_effort'].includes(this.auditPolicy)) throw new ContextLineError('INVALID_POLICY', 'Unknown audit policy');
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
  recordSourceEvent(input: SourceEventInput) { return this.registry.recordSourceEvent(input); }

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
        const allowed = reason === 'unregistered_allow_override';
        decisions.push({ artifactId:ref.id,artifactVersion:ref.version,allowed,outcome:allowed?'allowed':'denied',reason,sources:record?.sources.map(s => ({ id:s.id,version:s.version })) ?? [] });
        if (allowed) eligible.push({ artifact:candidate,ref,record:{ artifact:{ id:ref.id,version:ref.version,type:'other',connectorId:'unregistered',storageRef:'',tenantId:run.tenantId,status:'active',createdAt:'',updatedAt:'' },sources:[] } });
        preReasons.set(artifactKey(ref),reason);
      }
    }
    // Deduplicate by source ID, not by chunk. Authorization always concerns the current source.
    const sourceIds = new Map<string, SourceRef>();
    for (const item of eligible) for (const source of item.record.sources) if (!sourceIds.has(source.id)) sourceIds.set(source.id,{ id:source.id,version:source.version });
    let auth = new Map<string,boolean>();
    let authFailure: DecisionReason | undefined;
    if (sourceIds.size) {
      try { auth = await authorizationBatch(options.authorize,{ tenantId:run.tenantId,principal:run.principal,sources:[...sourceIds.values()] },options.timeoutMs ?? 500); }
      catch (error) { authFailure = error instanceof ContextLineError && error.code === 'AUTH_TIMEOUT' ? 'authorization_timeout' : 'authorization_error'; }
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
