import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresFixture } from './postgres-fixture.js';
import { ContextLine, PostgresRegistry, createPool } from '../packages/core/src/index.js';
import type { SourceRef } from '../packages/core/src/index.js';
import { LifecycleWorker, PostgresTableConnector } from '../packages/worker/src/index.js';
import type { ConnectorContext, StorageConnector } from '../packages/worker/src/index.js';

/** Blueprint A Part 6: five scripted failure stories, each with an expected outcome. */
let f: Awaited<ReturnType<typeof postgresFixture>>;
before(async () => { f = await postgresFixture(); });
after(async () => { await f?.cleanup(); });
const allow = async (req: { sources: SourceRef[] }) => Object.fromEntries(req.sources.map(s => [s.id, true]));
const tenant = 'chaos';
function connector(): PostgresTableConnector { return new PostgresTableConnector(f.app, { 'test-items': { table: 'test_items', statusColumn: 'status' } }); }
function worker(c: StorageConnector = connector(), overrides: Record<string, unknown> = {}) {
  return new LifecycleWorker({ registry: f.registry, connectors: { 'test-items': c }, tenants: [tenant], retryDelaysMs: [0, 0, 0], operationTimeoutMs: 200, leaseMs: 5000, batchSize: 10, ...overrides });
}
async function seed(root: SourceRef, id = randomUUID(), type: 'embedding' | 'cache' | 'summary' | 'memory' = 'embedding') {
  await f.ctx.ensureSource(tenant, root);
  const artifact = { id, type, connectorId: 'test-items', storageRef: `test-items/${id}` };
  await f.ctx.registerDerivation({ tenantId: tenant, sources: [root], artifacts: [artifact] });
  await f.app.query('INSERT INTO test_items (tenant_id,id) VALUES ($1,$2)', [tenant, id]);
  return artifact;
}
const row = async (id: string) => (await f.app.query('SELECT * FROM test_items WHERE tenant_id=$1 AND id=$2', [tenant, id])).rows[0];

test('chaos 1 — storage lies about a delete; verification catches it and the retry converges', async () => {
  const root = { id: `chaos-liar-${randomUUID()}`, version: 1 };
  const artifact = await seed(root);
  const real = connector();
  let lies = 1;
  const liar: StorageConnector = {
    type: 'postgres-table',
    async delete(ref: string, context: ConnectorContext) { if (lies-- > 0) return; return real.delete(ref, context); },
    invalidate: (ref, context) => real.invalidate(ref, context),
    verify: (ref, context, expected) => real.verify(ref, context, expected),
    healthCheck: () => real.healthCheck(),
  };
  const event = await f.ctx.recordSourceEvent({ tenantId: tenant, sourceId: root.id, event: 'document_deleted' });
  await worker(liar).drain(tenant);
  const job = (await f.registry.listJobs(tenant, event.id))[0]!;
  assert.equal(job.status, 'completed');
  assert.equal(job.attempts, 2, 'the first attempt must fail verification, not report success');
  assert.equal(job.history[0].verified, false);
  assert.equal(await row(artifact.id), undefined);
  assert.equal((await f.registry.getEvent(tenant, event.id))?.status, 'completed');
});

test('chaos 2 — a worker dies mid-job; the lease expires and another worker finishes exactly once', async () => {
  const root = { id: `chaos-kill-${randomUUID()}`, version: 1 };
  const artifact = await seed(root);
  const event = await f.ctx.recordSourceEvent({ tenantId: tenant, sourceId: root.id, event: 'document_deleted' });
  await f.registry.materializeNextEvent(tenant);
  // First worker claims the job, then "crashes" without finishing or releasing.
  const stolen = (await f.registry.claimJobs(tenant, 1, 1000))[0]!;
  assert.equal(stolen.status, 'processing');
  assert.equal(await f.registry.claimJobs(tenant, 1, 1000).then(j => j.length), 0, 'a live lease is not claimable');
  await delay(1100);
  const reclaimed = (await f.registry.claimJobs(tenant, 1, 5000))[0]!;
  assert.equal(reclaimed.id, stolen.id);
  assert.notEqual(reclaimed.leaseToken, stolen.leaseToken);
  assert.equal(reclaimed.attempts, 2);
  // The dead worker wakes up: its stale token must not be able to commit anything.
  assert.equal(await f.registry.finishJob(stolen, { status: 'completed', verified: true }), false);
  await connector().delete(reclaimed.storageRef, { tenantId: tenant });
  assert.equal(await f.registry.finishJob(reclaimed, { status: 'completed', verified: true }), true);
  assert.equal(await row(artifact.id), undefined);
  const jobs = await f.registry.listJobs(tenant, event.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.history.filter((h: { status: string }) => h.status === 'completed').length, 1);
  assert.equal((await f.registry.getEvent(tenant, event.id))?.status, 'completed');
});

test('chaos 3 — the authorization service blacks out; everything is denied and recovery restores service', async () => {
  const root = { id: `chaos-blackout-${randomUUID()}`, version: 1 };
  const artifact = await seed(root);
  const run = await f.ctx.beginRun(tenant, 'alice');
  const blackout = () => new Promise<Record<string, boolean>>(resolve => setTimeout(() => resolve({ [root.id]: true }), 200));
  const denied = await f.ctx.filterAuthorized({ run, candidates: [{ artifactId: artifact.id }], authorize: blackout, timeoutMs: 20 });
  assert.equal(denied.length, 0);
  const decisions = await f.registry.listDecisions(tenant, run.id);
  assert.equal(decisions[0]!.reason, 'authorization_timeout');
  assert.equal(decisions[0]!.outcome, 'denied');
  // Even an explicit fail-open must be recorded as an override, never as a clean allow.
  const overridden = await f.ctx.filterAuthorized({ run, candidates: [{ artifactId: artifact.id }], authorize: blackout, timeoutMs: 20, onError: 'allow' });
  assert.equal(overridden.length, 1);
  assert.equal((await f.registry.listDecisions(tenant, run.id))[0]!.reason, 'authorization_allow_override');
  const recovered = await f.ctx.filterAuthorized({ run, candidates: [{ artifactId: artifact.id }], authorize: allow });
  assert.equal(recovered.length, 1);
});

test('chaos 4 — the registry is unreachable; enforcement fails closed within the pool timeout', async () => {
  const dead = createPool({ host: '127.0.0.1', port: 1, user: 'nobody', database: 'nothing', max: 1, connectionTimeoutMillis: 200 });
  try {
    const ctx = new ContextLine(new PostgresRegistry(dead));
    const started = Date.now();
    const run = { id: randomUUID(), tenantId: tenant, principal: 'alice' };
    const result = await ctx.filterAuthorized({ run, candidates: [{ artifactId: 'anything' }], authorize: allow, onError: 'allow' });
    assert.equal(result.length, 0, 'a registry outage denies even when auth errors fail open');
    assert.ok(Date.now() - started < 5000, 'the pool timeout must bound the failure');
    assert.equal(await ctx.assertCanServe({ artifact: 'anything', tenantId: tenant, principal: 'alice', run, authorize: allow }), false);
    await ctx.close();
  } finally { await dead.end(); }
});

test('chaos 5 — a four-hop derivative chain is fully found by one forward lookup', async () => {
  const root = { id: `chaos-cascade-${randomUUID()}`, version: 1 };
  const chunk = await seed(root);
  const chain: { id: string; type: 'cache' | 'summary' | 'memory' }[] = [
    { id: `answer-${randomUUID()}`, type: 'cache' },
    { id: `summary-${randomUUID()}`, type: 'summary' },
    { id: `fact-${randomUUID()}`, type: 'memory' },
  ];
  let parent = { id: chunk.id, version: 1 };
  for (const link of chain) {
    await f.ctx.registerDerivation({
      tenantId: tenant, sources: [], derivedFrom: [parent],
      artifacts: [{ id: link.id, type: link.type, connectorId: 'test-items', storageRef: `test-items/${link.id}` }],
    });
    await f.app.query('INSERT INTO test_items (tenant_id,id) VALUES ($1,$2)', [tenant, link.id]);
    parent = { id: link.id, version: 1 };
  }
  // Every hop flattened to the same root, so one event reaches the whole chain.
  const records = await f.registry.lookupArtifacts(tenant, chain.map(c => ({ id: c.id, version: 1 })));
  for (const record of records) assert.deepEqual(record.sources.map(s => s.id), [root.id]);
  const event = await f.ctx.recordSourceEvent({ tenantId: tenant, sourceId: root.id, event: 'gdpr_erasure_requested' });
  assert.equal(await worker().drain(tenant), 4);
  assert.equal((await f.registry.getEvent(tenant, event.id))?.processedArtifacts, 4);
  for (const id of [chunk.id, ...chain.map(c => c.id)]) {
    assert.equal(await row(id), undefined);
    assert.equal((await f.registry.lookupArtifacts(tenant, [{ id, version: 1 }]))[0]!.artifact.status, 'deleted');
  }
});
