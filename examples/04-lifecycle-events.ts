import type { ContextLine, SourceEventInput } from '@contextline/core';

/**
 * Stage 4 — record lifecycle events.
 * The event, the source status change, and the local auth-cache purge happen in ONE
 * transaction. Scope matters: one user losing access must not delete everyone's answers.
 */
export type WebhookPayload =
  | { kind: 'user_lost_access'; documentId: string; principalId: string; deliveryId: string }
  | { kind: 'document_restricted_for_everyone'; documentId: string; deliveryId: string }
  | { kind: 'document_updated'; documentId: string; newVersion: number; deliveryId: string }
  | { kind: 'document_deleted'; documentId: string; deliveryId: string }
  | { kind: 'erasure_requested'; documentId: string; deliveryId: string }
  | { kind: 'retention_expired'; documentId: string; deliveryId: string };

export async function handleWebhook(ctx: ContextLine, tenantId: string, payload: WebhookPayload) {
  const base = { tenantId, sourceId: payload.documentId, idempotencyKey: payload.deliveryId };
  let input: SourceEventInput;
  switch (payload.kind) {
    case 'user_lost_access':
      // Principal-scoped: only this principal's cache and memory are touched.
      input = { ...base, event: 'permission_revoked', affectedPrincipals: [payload.principalId] };
      break;
    case 'document_restricted_for_everyone':
      // Source-wide: embeddings/cache/summaries are deleted, memory awaits review.
      input = { ...base, event: 'source_restricted', memoryAction: 'flag' };
      break;
    case 'document_updated':
      input = { ...base, event: 'document_updated', newVersion: payload.newVersion };
      break;
    case 'document_deleted':
      input = { ...base, event: 'document_deleted' };
      break;
    case 'erasure_requested':
      // Erasure always deletes memory, regardless of the review policy.
      input = { ...base, event: 'gdpr_erasure_requested' };
      break;
    case 'retention_expired':
      input = { ...base, event: 'retention_expired' };
      break;
  }
  const event = await ctx.recordSourceEvent(input);
  // Retrieval is already blocked. The worker now converges storage asynchronously.
  return { eventId: event.id, scope: event.scope, status: event.status };
}
