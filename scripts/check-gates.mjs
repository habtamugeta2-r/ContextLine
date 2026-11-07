#!/usr/bin/env node
// Blueprint A Part 1 CI gates. These protect product promises, not style.
//   1. the SDK's runtime dependency list is exactly `pg`
//   2. the shipped SDK output stays under 50KB gzipped
//   3. no code outside the registry store and the connectors issues SQL,
//      and the registry store only ever names registry tables
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const coreManifest = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
const runtimeDeps = Object.keys(coreManifest.dependencies ?? {}).sort();
check('SDK runtime dependencies are exactly pg', JSON.stringify(runtimeDeps) === '["pg"]', runtimeDeps.join(', ') || '(none)');
check('SDK declares no optional or peer runtime dependencies',
  Object.keys(coreManifest.peerDependencies ?? {}).length === 0 && Object.keys(coreManifest.optionalDependencies ?? {}).length === 0);

// Conservative upper bound: the real shipped ESM output, gzipped, with no minification
// or tree-shaking. A bundler could only make this smaller.
const distFiles = (await readdir('packages/core/dist')).filter(f => f.endsWith('.js')).sort();
const shipped = (await Promise.all(distFiles.map(f => readFile(join('packages/core/dist', f))))).reduce((total, buffer) => total + buffer.length, 0);
const gzipped = gzipSync(Buffer.concat(await Promise.all(distFiles.map(f => readFile(join('packages/core/dist', f)))))).length;
check('SDK shipped output is under 50KB gzipped', gzipped < 50 * 1024, `${(gzipped / 1024).toFixed(1)}KB gzipped / ${(shipped / 1024).toFixed(1)}KB raw across ${distFiles.length} modules`);

const REGISTRY_TABLES = new Set(['sources', 'artifacts', 'dependencies', 'lifecycle_events', 'lifecycle_jobs', 'access_runs', 'access_decisions', 'quarantine_manifest', 'schema_migrations']);
const SQL_ALLOWED = new Set(['packages/core/src/postgres.ts', 'packages/worker/src/connectors.ts']);
const sources = [];
for (const pkg of ['core', 'worker']) {
  for (const file of await readdir(`packages/${pkg}/src`)) {
    if (file.endsWith('.ts')) sources.push(`packages/${pkg}/src/${file}`);
  }
}
const offenders = sources.filter(path => !SQL_ALLOWED.has(path));
const leaking = [];
for (const path of offenders) {
  const text = await readFile(path, 'utf8');
  if (/\.query\s*\(/.test(text)) leaking.push(path);
}
check('no SQL outside the registry store and connectors', leaking.length === 0, leaking.join(', ') || `${offenders.length} modules scanned`);

const registrySource = await readFile('packages/core/src/postgres.ts', 'utf8');
const named = [...registrySource.matchAll(/this\.table\('([a-z_]+)'\)/g)].map(m => m[1]);
const unknown = [...new Set(named)].filter(name => !REGISTRY_TABLES.has(name));
check('registry store only names registry tables', unknown.length === 0, unknown.join(', ') || `${new Set(named).size} registry tables`);
const customerSql = /\b(FROM|INTO|UPDATE|JOIN)\s+(public\.|customer_|embeddings|documents|chunks|memories)/i.test(registrySource);
check('registry store never reaches customer storage tables', !customerSql);

const workerSource = await readFile('packages/worker/src/worker.ts', 'utf8');
check('worker acts on storage only through connectors', !/\.query\s*\(/.test(workerSource) && /connector\.(delete|invalidate|verify)/.test(workerSource));

if (failures.length) {
  console.error(`\n${failures.length} blueprint gate(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll blueprint gates passed.');
}
