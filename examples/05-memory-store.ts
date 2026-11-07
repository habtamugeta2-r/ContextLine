import type { ContextLine } from '@contextline/core';
import type { PermissionService } from './shared.js';

/**
 * Stage 5 — agent memory.
 * Memory is registered with an opaque owner so a single principal's revocation can
 * reach it, and every read is a serving decision. Flagged memory stays blocked even
 * after an operator acknowledges the review.
 */
export async function rememberFact(options: {
  ctx: ContextLine; tenantId: string; principal: string; factId: string;
  roots: { id: string; version: number }[];
}): Promise<void> {
  const { ctx, tenantId, principal, factId, roots } = options;
  await ctx.registerDerivation({
    tenantId, sources: roots,
    artifacts: [{
      id: factId, type: 'memory', connectorId: 'postgres-table',
      storageRef: `postgres:memories:${factId}`, ownerPrincipal: principal,
    }],
  });
}
export async function recallFact(options: {
  ctx: ContextLine; permissions: PermissionService; tenantId: string; principal: string; factId: string;
}): Promise<boolean> {
  const { ctx, permissions, tenantId, principal, factId } = options;
  return ctx.assertCanServe({
    artifact: { id: factId }, tenantId, principal,
    authorize: request => permissions.check(request),
  });
}
