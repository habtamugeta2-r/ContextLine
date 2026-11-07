#!/usr/bin/env node
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { PostgresRegistry, migrateRegistry } from './postgres.js';
import { ContextLineError } from './validation.js';

/**
 * Operator CLI.
 *   contextline-migrate [migrate]
 *   contextline-migrate quarantine list     --tenant T [--all]
 *   contextline-migrate quarantine resolve  --tenant T --artifact ID[@version]
 *   contextline-migrate quarantine backfill --tenant T --file mappings.json
 * Migration uses the schema-owner URL; quarantine commands use the runtime URL.
 * Errors never echo connection strings or row contents.
 */
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'migrate';
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const schema = process.env.CONTEXTLINE_SCHEMA ?? 'contextline';
const fail = (message: string): void => { console.error(message); process.exitCode = 1; };

if (command === 'migrate') {
  const url = process.env.CONTEXTLINE_MIGRATION_DATABASE_URL;
  if (!url) fail('Set CONTEXTLINE_MIGRATION_DATABASE_URL to the schema-owner connection.');
  else {
    const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
    try { await migrateRegistry(pool, { schema }); console.log('ContextLine migrations applied.'); }
    catch { fail('Migration failed. Check the owner connection, PostgreSQL version, and migration checksums.'); }
    finally { await pool.end(); }
  }
} else if (command === 'quarantine') {
  const url = process.env.CONTEXTLINE_DATABASE_URL;
  const tenantId = flag('tenant');
  const action = args[1];
  if (!url) fail('Set CONTEXTLINE_DATABASE_URL to the runtime (non-owner, NOBYPASSRLS) connection.');
  else if (!tenantId) fail('Pass --tenant so the manifest is read under one tenant policy.');
  else if (!['list', 'resolve', 'backfill'].includes(action ?? '')) fail('Usage: quarantine <list|resolve|backfill> --tenant T');
  else {
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000 });
    const registry = new PostgresRegistry(pool, { schema });
    try {
      if (action === 'list') {
        const entries = await registry.listQuarantine(tenantId, args.includes('--all'));
        console.log(JSON.stringify(entries, null, 2));
        console.error(`${entries.length} manifest row(s). Assign root sources, then run backfill.`);
      } else if (action === 'resolve') {
        const artifact = flag('artifact');
        if (!artifact) fail('Pass --artifact ID[@version].');
        else {
          const [id, version] = artifact.split('@');
          const resolved = await registry.resolveQuarantine(tenantId, [{ id: id!, version: version ? Number(version) : 1 }]);
          console.log(`Resolved ${resolved} manifest row(s). The artifact itself is unchanged.`);
        }
      } else {
        const file = flag('file');
        if (!file) fail('Pass --file mappings.json: [{artifactId,artifactVersion?,type,connectorId,storageRef,sources:[{id,version}]}].');
        else {
          const mappings = JSON.parse(await readFile(file, 'utf8')) as {
            artifactId: string; artifactVersion?: number; type: 'embedding' | 'cache' | 'summary' | 'memory' | 'other';
            connectorId: string; storageRef: string; ownerPrincipal?: string; sources: { id: string; version: number }[];
          }[];
          if (!Array.isArray(mappings) || !mappings.length) fail('The mapping file must be a nonempty array.');
          else {
            let registered = 0, resolved = 0;
            const failures: { artifactId: string; code: string }[] = [];
            for (const mapping of mappings) {
              try {
                await registry.registerDerivation({
                  tenantId, sources: mapping.sources,
                  artifacts: [{
                    id: mapping.artifactId, version: mapping.artifactVersion ?? 1, type: mapping.type,
                    connectorId: mapping.connectorId, storageRef: mapping.storageRef,
                    ...(mapping.ownerPrincipal ? { ownerPrincipal: mapping.ownerPrincipal } : {}),
                  }],
                });
                registered++;
                resolved += await registry.resolveQuarantine(tenantId, [{ id: mapping.artifactId, version: mapping.artifactVersion ?? 1 }]);
              } catch (error) {
                failures.push({ artifactId: mapping.artifactId, code: error instanceof ContextLineError ? error.code : 'REGISTRATION_FAILED' });
              }
            }
            console.log(JSON.stringify({ registered, resolved, failures }, null, 2));
            if (failures.length) process.exitCode = 1;
          }
        }
      }
    } catch (error) {
      fail(error instanceof ContextLineError ? `Quarantine command failed: ${error.code}` : 'Quarantine command failed. Check the connection, tenant, and input file.');
    } finally { await pool.end(); }
  }
} else {
  fail(`Unknown command: ${command}`);
}
