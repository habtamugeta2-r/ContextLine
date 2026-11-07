import type { ArtifactRegistration, ArtifactRef, EnforcementOptions, RegisterDerivationInput, SourceEventInput, SourceRef } from './types.js';

export class ContextLineError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ContextLineError';
  }
}
export function identifier(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ContextLineError('INVALID_IDENTIFIER', `${label} must be a nonempty string of at most ${max} characters without control characters`);
  }
}
export function version(value: unknown, label = 'version'): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647) {
    throw new ContextLineError('INVALID_VERSION', `${label} must be a positive 32-bit integer`);
  }
}
export function sourceRef(value: SourceRef): Required<SourceRef> {
  identifier(value.id, 'source ID'); version(value.version); return { id: value.id, version: value.version };
}
export function artifactRef(value: ArtifactRef): { id: string; version: number } {
  identifier(value.id, 'artifact ID'); const v = value.version ?? 1; version(v); return { id: value.id, version: v };
}
export function artifactKey(value: ArtifactRef): string { const ref = artifactRef(value); return JSON.stringify([ref.id, ref.version]); }
export function boundedArray(value: unknown, label: string, max: number, allowEmpty = false): asserts value is unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new ContextLineError('INVALID_BATCH', `${label} must contain ${allowEmpty ? 0 : 1}–${max} items`);
  }
}
export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map(item => [key(item), item])).values()];
}
export function validateRegistration(input: RegisterDerivationInput): void {
  identifier(input.tenantId, 'tenant ID'); boundedArray(input.sources, 'sources', 100, !!input.derivedFrom?.length);
  boundedArray(input.artifacts, 'artifacts', 500);
  input.sources.forEach(sourceRef);
  for (const a of input.artifacts) {
    artifactRef(a); identifier(a.connectorId, 'connector ID', 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(a.connectorId)) throw new ContextLineError('INVALID_IDENTIFIER', 'connector ID must be a lowercase configured name');
    identifier(a.storageRef, 'storage reference', 1024);
    if (a.ownerPrincipal !== undefined) identifier(a.ownerPrincipal, 'owner principal', 512);
    if (!['embedding', 'cache', 'summary', 'memory', 'other'].includes(a.type)) throw new ContextLineError('INVALID_TYPE', 'Unknown artifact type');
  }
  if (uniqueBy(input.artifacts, artifactKey).length !== input.artifacts.length) throw new ContextLineError('DUPLICATE_ARTIFACT', 'Duplicate artifact version in registration');
  if (input.derivedFrom) { input.derivedFrom.forEach(artifactRef); boundedArray(input.derivedFrom, 'derivedFrom', 100); }
  if (new Set(input.sources.map(s => s.id)).size !== input.sources.length) throw new ContextLineError('AMBIGUOUS_SOURCE', 'Register one version per root source');
}
export function validateEvent(input: SourceEventInput): void {
  identifier(input.tenantId, 'tenant ID'); identifier(input.sourceId, 'source ID');
  const types = ['permission_revoked', 'permission_granted', 'document_updated', 'document_deleted', 'retention_expired', 'gdpr_erasure_requested', 'source_restricted', 'source_reactivated'];
  if (!types.includes(input.event)) throw new ContextLineError('INVALID_EVENT', 'Unknown lifecycle event');
  if (input.affectedPrincipals !== undefined) {
    boundedArray(input.affectedPrincipals, 'affectedPrincipals', 100, true);
    input.affectedPrincipals.forEach(p => identifier(p, 'principal', 512));
  }
  if (['permission_revoked', 'permission_granted'].includes(input.event) && !input.affectedPrincipals?.length) {
    throw new ContextLineError('PRINCIPALS_REQUIRED', 'Principal permission events require affectedPrincipals; use source_restricted/source_reactivated for source-wide changes');
  }
  if (input.newVersion !== undefined) version(input.newVersion, 'newVersion');
  if (input.event === 'document_updated' ? input.newVersion === undefined : input.newVersion !== undefined) throw new ContextLineError('INVALID_VERSION', 'newVersion is required only for document_updated');
  if (input.idempotencyKey !== undefined) identifier(input.idempotencyKey, 'idempotency key', 128);
  if (input.memoryAction !== undefined && !['flag', 'invalidate', 'delete'].includes(input.memoryAction)) throw new ContextLineError('INVALID_ACTION', 'Unknown memory action');
  if (input.memoryAction && !['source_restricted','retention_expired','permission_revoked'].includes(input.event)) throw new ContextLineError('INVALID_ACTION', 'memoryAction applies only to restriction, retention, and principal-scoped revocation');
}
export function validateEnforcement(options: EnforcementOptions): void {
  if (typeof options.authorize !== 'function') throw new ContextLineError('INVALID_CALLBACK', 'authorize must be a function');
  if (options.unregisteredPolicy && !['deny', 'allow', 'quarantine'].includes(options.unregisteredPolicy)) throw new ContextLineError('INVALID_POLICY', 'Unknown unregisteredPolicy');
  if (options.onError && !['deny', 'allow', 'skip'].includes(options.onError)) throw new ContextLineError('INVALID_POLICY', 'Unknown onError');
  if (options.authorizeMode && !['batch','per-source'].includes(options.authorizeMode)) throw new ContextLineError('INVALID_POLICY', 'Unknown authorizeMode');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000)) throw new ContextLineError('INVALID_TIMEOUT', 'timeoutMs must be 1–30000');
}
export function validateArtifact(input: ArtifactRegistration): void {
  validateRegistration({ tenantId: 'validation', sources: [{ id: 'validation', version: 1 }], artifacts: [input] });
}
