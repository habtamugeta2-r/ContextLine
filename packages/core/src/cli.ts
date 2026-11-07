#!/usr/bin/env node
import pg from 'pg';
import { migrateRegistry } from './postgres.js';
const url = process.env.CONTEXTLINE_MIGRATION_DATABASE_URL;
if (!url) { console.error('Set CONTEXTLINE_MIGRATION_DATABASE_URL to the schema-owner connection.'); process.exitCode=1; }
else {
  const pool = new pg.Pool({ connectionString:url, max:1, connectionTimeoutMillis:5000 });
  try { await migrateRegistry(pool,{ schema:process.env.CONTEXTLINE_SCHEMA ?? 'contextline' }); console.log('ContextLine migrations applied.'); }
  catch { console.error('Migration failed. Check the owner connection, PostgreSQL version, and migration checksums.'); process.exitCode=1; }
  finally { await pool.end(); }
}
