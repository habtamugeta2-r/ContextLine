import pg from 'pg';
import { grantRuntimeRole } from '../packages/core/dist/index.js';
const url=process.env.CONTEXTLINE_MIGRATION_DATABASE_URL;
const role=process.env.CONTEXTLINE_RUNTIME_ROLE;
const password=process.env.CONTEXTLINE_RUNTIME_PASSWORD;
if(!url||!role||!password||password.length<16){console.error('Set owner URL, runtime role, and a runtime password of at least 16 characters.');process.exit(1);}
if(!/^[a-z][a-z0-9_]{0,62}$/.test(role)){console.error('Invalid runtime role name.');process.exit(1);}
const pool=new pg.Pool({connectionString:url,max:1});
try{
  const exists=await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  // format(%I/%L) performs server-side identifier/literal quoting; no password appears in logs.
  const command=exists.rowCount?'ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L':'CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L';
  const sql=await pool.query(`SELECT format('${command}',$1,$2) AS sql`,[role,password]);
  await pool.query(sql.rows[0].sql);
  await grantRuntimeRole(pool,role,process.env.CONTEXTLINE_SCHEMA??'contextline');
  console.log('Runtime role provisioned with least-privilege DML and forced RLS.');
}catch{console.error('Role provisioning failed. Check owner privileges and schema migration state.');process.exitCode=1;}
finally{await pool.end();}
