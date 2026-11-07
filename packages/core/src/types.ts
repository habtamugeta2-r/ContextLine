export type ArtifactType = 'embedding' | 'cache' | 'summary' | 'memory' | 'other';
export type ArtifactStatus = 'active' | 'stale' | 'deleted' | 'pending_review';
export type SourceStatus = 'active' | 'revoked' | 'deleted' | 'expired';
export type EventType = 'permission_revoked' | 'permission_granted' | 'document_updated' | 'document_deleted' | 'retention_expired' | 'gdpr_erasure_requested' | 'source_restricted' | 'source_reactivated';
export type LifecycleAction = 'delete' | 'invalidate' | 'flag';
export type EventStatus = 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
export type JobStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'pending_review' | 'failed';
export interface SourceRef { id: string; version: number }
export interface ArtifactRef { id: string; version?: number | undefined }
export interface ResolvedArtifactRef { id: string; version: number }
export interface ArtifactRegistration {
  id: string;
  version?: number | undefined;
  type: ArtifactType;
  connectorId: string;
  storageRef: string;
}
export interface SourceState extends SourceRef { status: SourceStatus; isCurrent: boolean }
export interface ArtifactRecord {
  id: string; version: number; type: ArtifactType; connectorId: string;
  storageRef: string; tenantId: string; status: ArtifactStatus;
  createdAt: string; updatedAt: string;
}
export interface ArtifactDependencies { artifact: ArtifactRecord; sources: SourceState[] }
export interface Run { id: string; tenantId: string; principal: string }
export type DecisionReason =
  | 'allowed' | 'unregistered' | 'quarantined' | 'empty_provenance'
  | 'artifact_deleted' | 'artifact_stale' | 'artifact_pending_review'
  | 'source_deleted' | 'source_revoked' | 'source_expired' | 'source_outdated'
  | 'source_missing' | 'authorization_denied' | 'authorization_error'
  | 'authorization_timeout' | 'authorization_allow_override'
  | 'unregistered_allow_override' | 'registry_error' | 'audit_error';
export interface AccessDecision {
  artifactId: string; artifactVersion: number; allowed: boolean;
  outcome: 'allowed' | 'denied' | 'skipped'; reason: DecisionReason; sources: SourceRef[];
}
export interface AuthorizationRequest { tenantId: string; principal: string; sources: SourceRef[] }
export type AuthorizationCallback = (request: AuthorizationRequest) => Promise<Record<string, boolean> | Map<string, boolean>>;
export interface EnforcementOptions {
  authorize: AuthorizationCallback;
  unregisteredPolicy?: 'deny' | 'allow' | 'quarantine' | undefined;
  onError?: 'deny' | 'allow' | 'skip' | undefined;
  timeoutMs?: number | undefined;
  /** Stale versions are denied regardless of this setting. Deleted/expired sources always deny. */
  allowOutdatedVersions?: boolean | undefined;
}
export interface AuthorizedArtifact<T> { artifact: T; sourceRefs: SourceRef[] }
export interface RegisterDerivationInput {
  tenantId: string; sources: SourceRef[]; artifacts: ArtifactRegistration[];
  /** Pass artifact IDs to resolve and flatten their root-source dependencies. */
  derivedFrom?: ArtifactRef[] | undefined;
  run?: Run | undefined;
}
export interface SourceEventInput {
  tenantId: string; sourceId: string; event: EventType;
  affectedPrincipals?: string[] | undefined;
  newVersion?: number | undefined;
  idempotencyKey?: string | undefined;
  /** Only restricted sources: flag (default), invalidate, or delete. Erasure always deletes. */
  memoryAction?: LifecycleAction | undefined;
}
export interface LifecycleEventRecord {
  id: string; tenantId: string; sourceId: string; sourceVersion: number;
  eventType: EventType; affectedPrincipals: string[]; affectedArtifacts: number;
  processedArtifacts: number; status: EventStatus; jobsReady: boolean;
  details: Record<string, unknown>; createdAt: string; startedAt: string | null; completedAt: string | null;
}
export interface LifecycleJob {
  id: string; eventId: string; tenantId: string;
  artifactId: string; artifactVersion: number; artifactType: ArtifactType;
  connectorId: string; storageRef: string; action: LifecycleAction;
  status: JobStatus; attempts: number; maxAttempts: number;
  nextAttemptAt: string; leaseUntil: string | null; leaseToken: string | null;
  lastErrorCode: string | null; verifiedAt: string | null;
  history: Record<string, unknown>[];
}
export interface Diagnostic { code: string; operation: string; tenantId: string }
export interface RegistryStore {
  ensureSource(tenantId: string, source: SourceRef): Promise<void>;
  registerDerivation(input: RegisterDerivationInput): Promise<void>;
  lookupArtifacts(tenantId: string, refs: ResolvedArtifactRef[]): Promise<ArtifactDependencies[]>;
  beginRun(tenantId: string, principal: string): Promise<Run>;
  recordDecisions(run: Run, decisions: AccessDecision[], durationMs: number): Promise<void>;
  recordSourceEvent(input: SourceEventInput): Promise<LifecycleEventRecord>;
}
