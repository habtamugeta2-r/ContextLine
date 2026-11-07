import type { ContextLine } from '@contextline/core';
import type { AnswerCache, PermissionService, VectorStore } from './shared.js';

/**
 * Stage 2 — filter at retrieval.
 * One batched backward lookup, one authorization round per unique root source, and a
 * candidate survives only if EVERY root authorizes. Ranking order is preserved.
 */
export async function answerQuestion(options: {
  ctx: ContextLine; vectors: VectorStore; cache: AnswerCache; permissions: PermissionService;
  tenantId: string; principal: string; question: string;
}): Promise<{ answer: string; usedArtifacts: string[] }> {
  const { ctx, vectors, cache, permissions, tenantId, principal, question } = options;
  const run = await ctx.beginRun(tenantId, principal);
  const hits = await vectors.search(question, 10);
  const authorized = await ctx.filterAuthorized({
    run,
    candidates: hits.map(hit => ({ artifactId: hit.artifactId, artifactVersion: hit.artifactVersion, text: hit.text })),
    authorize: request => permissions.check(request),
    // Defaults are already fail-closed: deny on auth error, deny unregistered,
    // 500ms timeout, required audit. Nothing here relaxes them.
  });
  if (!authorized.length) return { answer: 'I do not have access to sources that answer that.', usedArtifacts: [] };

  const answer = authorized.map(item => item.artifact.text).join('\n');
  // The answer is itself a derivative. Register it against the ROOT sources
  // (sourceRefs), not against the chunks, so one forward lookup finds the whole chain.
  const answerId = `answer:${run.id}`;
  await ctx.registerDerivation({
    tenantId, run,
    sources: dedupeRoots(authorized.flatMap(item => item.sourceRefs)),
    artifacts: [{ id: answerId, type: 'cache', connectorId: 'redis', storageRef: `redis:answers:${tenantId}:${answerId}`, ownerPrincipal: principal }],
  });
  await cache.set(`${tenantId}:${answerId}`, answer);
  return { answer, usedArtifacts: authorized.map(item => item.artifact.artifactId) };
}
function dedupeRoots(refs: { id: string; version: number }[]): { id: string; version: number }[] {
  return [...new Map(refs.map(ref => [ref.id, ref])).values()];
}
