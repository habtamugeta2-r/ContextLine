import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { postgresFixture } from '../tests/postgres-fixture.js';

/**
 * Blueprint A Part 6 benchmark.
 *   BENCH_ROWS       target dependency rows (default 100000; blueprint target 1000000)
 *   BENCH_TENANTS    tenants (default 50)
 *   BENCH_ITERATIONS measured calls per phase (default 300; blueprint target 10000)
 *   BENCH_CACHE=1    also measure the opt-in allow cache
 *   BENCH_GATE=1     exit non-zero when a p95 gate is missed (nightly CI)
 *   BENCH_OUT=path   also write the JSON report to a file
 * The report always states what is included: this is a local synthetic measurement,
 * not a production latency or scale claim.
 */
const rows = Number(process.env.BENCH_ROWS ?? 100000);
const tenants = Number(process.env.BENCH_TENANTS ?? 50);
const iterations = Number(process.env.BENCH_ITERATIONS ?? 300);
const rootsPerArtifact = 4, candidatesPerRequest = 10, sourcesPerTenant = 200, batchSize = 500;
const artifacts = Math.max(candidatesPerRequest, Math.floor(rows / (tenants * rootsPerArtifact)));
const f = await postgresFixture();
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]!;
const ms = (values: number[], p: number) => Number(percentile(values, p).toFixed(2));
try {
  const tenantIds = Array.from({ length: tenants }, (_, i) => `bench-tenant-${i + 1}`);
  const seedStart = performance.now();
  for (const [t, tenantId] of tenantIds.entries()) {
    for (let s = 0; s < sourcesPerTenant; s += 100) {
      await f.registry.transaction(tenantId, async c => {
        await c.query('INSERT INTO contextline.sources (tenant_id,source_id,version) SELECT $1,s.id,1 FROM unnest($2::text[]) AS s(id) ON CONFLICT DO NOTHING',
          [tenantId, Array.from({ length: Math.min(100, sourcesPerTenant - s) }, (_, i) => `bench-source-${s + i + 1}`)]);
      });
    }
    for (let batch = 0; batch * batchSize < artifacts; batch++) {
      const count = Math.min(batchSize, artifacts - batch * batchSize);
      const roots = Array.from({ length: rootsPerArtifact }, (_, r) => ({ id: `bench-source-${((batch * rootsPerArtifact + r) % sourcesPerTenant) + 1}`, version: 1 }));
      await f.ctx.registerDerivation({
        tenantId, sources: roots,
        artifacts: Array.from({ length: count }, (_, i) => ({ id: `bench-${batch * batchSize + i}`, type: 'embedding' as const, connectorId: 'bench', storageRef: `bench-${batch * batchSize + i}` })),
      });
    }
    if (t === 0) console.error(`seeded first tenant in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`);
  }
  const seedSeconds = (performance.now() - seedStart) / 1000;
  const dependencyRows = (await f.admin.query('SELECT count(*)::bigint AS n FROM contextline.dependencies')).rows[0].n;
  const tenant = tenantIds[0]!;
  const candidates = Array.from({ length: candidatesPerRequest }, (_, i) => ({ artifactId: `bench-${i}` }));
  const refs = candidates.map(c => ({ id: c.artifactId, version: 1 }));
  const authorize = async (req: { sources: { id: string }[] }) => Object.fromEntries(req.sources.map(s => [s.id, true]));

  const lookupSamples: number[] = [], fullSamples: number[] = [], warmSamples: number[] = [];
  for (let i = 0; i < 20; i++) { const run = await f.ctx.beginRun(tenant, 'bench'); await f.ctx.filterAuthorized({ run, candidates, authorize }); }
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const records = await f.registry.lookupArtifacts(tenant, refs);
    lookupSamples.push(performance.now() - start);
    if (records.length !== candidatesPerRequest) throw new Error('Benchmark lookup returned the wrong cardinality');
  }
  for (let i = 0; i < iterations; i++) {
    const run = await f.ctx.beginRun(tenant, 'bench');
    const start = performance.now();
    const result = await f.ctx.filterAuthorized({ run, candidates, authorize });
    if (result.length !== candidatesPerRequest) throw new Error('Benchmark authorization failed');
    fullSamples.push(performance.now() - start);
  }
  let warm: { p50Ms: number; p95Ms: number } | null = null;
  if (process.env.BENCH_CACHE === '1') {
    const { ContextLine } = await import('../packages/core/src/index.js');
    const cached = new ContextLine(f.registry, { authCache: { enabled: true, ttlMs: 30000 } });
    try {
      for (let i = 0; i < 20; i++) { const run = await cached.beginRun(tenant, 'bench'); await cached.filterAuthorized({ run, candidates, authorize }); }
      for (let i = 0; i < iterations; i++) {
        const run = await cached.beginRun(tenant, 'bench');
        const start = performance.now();
        const result = await cached.filterAuthorized({ run, candidates, authorize });
        if (result.length !== candidatesPerRequest) throw new Error('Benchmark warm-cache authorization failed');
        warmSamples.push(performance.now() - start);
      }
      warm = { p50Ms: ms(warmSamples, .5), p95Ms: ms(warmSamples, .95) };
    } finally { await cached.close(); }
  }
  const gates = {
    lookupP95Under2Ms: ms(lookupSamples, .95) < 2,
    filterP95Under5Ms: ms(fullSamples, .95) < 5,
    ...(warm ? { warmCacheP95Under2_5Ms: warm.p95Ms < 2.5 } : {}),
  };
  const report = {
    date: new Date().toISOString(), node: process.version, postgresql: f.version,
    cpu: cpus()[0]?.model, cpuCount: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3),
    tenants, dependencyRows: Number(dependencyRows), artifactsPerTenant: artifacts,
    rootsPerArtifact, candidatesPerRequest, iterations, warmup: 20, seedSeconds: Number(seedSeconds.toFixed(1)),
    registration: { artifactsPerStatement: batchSize, bulkWritesPerBatch: 2, artifactsPerSecond: Math.round(artifacts * tenants / seedSeconds) },
    lookup: { p50Ms: ms(lookupSamples, .5), p95Ms: ms(lookupSamples, .95), maxMs: Number(Math.max(...lookupSamples).toFixed(2)), roundTrips: 1 },
    filterAuthorized: { p50Ms: ms(fullSamples, .5), p95Ms: ms(fullSamples, .95), maxMs: Number(Math.max(...fullSamples).toFixed(2)) },
    warmCache: warm,
    includes: ['single-round-trip dependency lookup', 'synthetic authorization callback', 'durable audit write'],
    excludes: ['vector search', 'network authorization service', 'LLM inference', 'run creation'],
    gates, allGatesMet: Object.values(gates).every(Boolean),
    warning: 'Local synthetic microbenchmark on shared sandbox hardware, not a production latency or scale claim.',
  };
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, text + '\n');
  if (process.env.BENCH_GATE === '1' && !report.allGatesMet) process.exitCode = 1;
} finally { await f.cleanup(); }
