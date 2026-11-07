import type { ArtifactType, EventType, LifecycleAction } from './types.js';

/**
 * Blueprint A Part 5 action matrix, in one auditable place.
 * `memoryAction` only softens/hardens the memory column for restriction, retention
 * and principal-scoped revocation. Erasure and deletion always delete memory.
 */
export function lifecycleActionFor(event: EventType, type: ArtifactType, memoryAction: LifecycleAction = 'flag'): LifecycleAction | null {
  switch (event) {
    case 'document_deleted':
    case 'gdpr_erasure_requested':
      return 'delete';
    case 'retention_expired':
    case 'source_restricted':
      return type === 'memory' ? memoryAction : 'delete';
    case 'document_updated':
      return type === 'cache' ? 'delete' : 'invalidate';
    case 'permission_revoked':
      // Principal-scoped: only the affected principal's cache and memory are touched.
      if (type === 'cache') return 'delete';
      return type === 'memory' ? memoryAction : null;
    case 'permission_granted':
    case 'source_reactivated':
      return null;
  }
}
export function eventScope(event: EventType): 'principal' | 'source_wide' {
  return event === 'permission_revoked' || event === 'permission_granted' ? 'principal' : 'source_wide';
}
/** Blueprint A Part 5: 1s, 5s, 30s, 5m, 30m with ~10% jitter. */
export const RETRY_DELAYS_MS = [1000, 5000, 30000, 300000, 1800000] as const;
export function retryDelayMs(attempt: number, schedule: readonly number[] = RETRY_DELAYS_MS, jitter = 0.1, random: () => number = Math.random): number {
  const base = schedule[Math.min(Math.max(attempt, 1) - 1, schedule.length - 1)] ?? 1000;
  if (jitter <= 0) return base;
  return Math.max(0, Math.round(base * (1 - jitter + random() * jitter * 2)));
}
/** Errors that can never succeed on retry go straight to the dead-letter path. */
export const NON_RETRYABLE_CODES = new Set([
  'UNKNOWN_TABLE','INVALID_STORAGE_REFERENCE','CONNECTOR_NOT_CONFIGURED',
  'INVALID_TABLE_CONFIGURATION','INVALIDATION_NOT_SUPPORTED','TENANT_PREFIX_REQUIRED',
]);
