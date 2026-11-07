import type { ContextLine } from '@contextline/core';
import type { AnswerCache, PermissionService } from './shared.js';

/**
 * Stage 3 — revalidate cached answers.
 * A cache hit is a serving decision, so it goes through the same enforcement core.
 * This is what makes revocation visible BEFORE the worker has cleaned anything up.
 */
export async function serveCachedAnswer(options: {
  ctx: ContextLine; cache: AnswerCache; permissions: PermissionService;
  tenantId: string; principal: string; answerId: string;
}): Promise<{ served: boolean; answer?: string }> {
  const { ctx, cache, permissions, tenantId, principal, answerId } = options;
  const allowed = await ctx.assertCanServe({
    artifact: { id: answerId }, tenantId, principal,
    authorize: request => permissions.check(request),
  });
  if (!allowed) return { served: false };
  const answer = await cache.get(`${tenantId}:${answerId}`);
  return answer === null ? { served: false } : { served: true, answer };
}
