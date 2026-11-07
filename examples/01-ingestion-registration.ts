import { ContextLine, ContextLineError } from '@contextline/core';
import type { VectorStore } from './shared.js';

/**
 * Stage 1 — register at ingestion.
 * Rule: register the intent BEFORE writing to storage. A registered-but-never-written
 * artifact is harmless (deletion is idempotent); a written-but-unregistered artifact is
 * an unprotected orphan that no revocation can find.
 */
export async function ingestDocument(options: {
  ctx: ContextLine; vectors: VectorStore; tenantId: string;
  documentId: string; documentVersion: number; chunks: { id: string; text: string }[];
}): Promise<{ registered: number; skipped: boolean }> {
  const { ctx, vectors, tenantId, documentId, documentVersion, chunks } = options;
  const source = { id: documentId, version: documentVersion };
  try {
    await ctx.registerDerivation({
      tenantId,
      // createSources inserts a brand-new version-1 source in the same transaction.
      // It can never reactivate a revoked or deleted source.
      createSources: true,
      sources: [source],
      artifacts: chunks.map(chunk => ({
        id: chunk.id, type: 'embedding' as const, connectorId: 'pgvector',
        storageRef: `pgvector:chunks:${chunk.id}`,
      })),
    });
  } catch (error) {
    if (error instanceof ContextLineError && error.code === 'SOURCE_UNAVAILABLE') {
      // The source was revoked or superseded while this pipeline was running.
      // Do not write anything; let the lifecycle worker own the cleanup.
      return { registered: 0, skipped: true };
    }
    throw error;
  }
  for (const chunk of chunks) await vectors.write(chunk.id, chunk.text);
  return { registered: chunks.length, skipped: false };
}
