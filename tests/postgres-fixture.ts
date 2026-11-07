import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { LocalPostgres } from '../apps/demo/src/local-postgres.js';
import { freePort } from '../apps/demo/src/app.js';
import { ContextLine,PostgresRegistry,migrateRegistry,grantRuntimeRole } from '../packages/core/src/index.js';
export async function postgresFixture(){
  const dataDir=resolve('.contextline',`test-${randomUUID()}`),port=await freePort();
  const cluster=new LocalPostgres({databaseDir:dataDir,port,password:'test_local_only'});
  await cluster.initialise();await cluster.start();
  const config={host:'127.0.0.1',port,user:'postgres',password:'test_local_only',connectionTimeoutMillis:3000};
  const bootstrap=new pg.Pool({...config,database:'postgres',max:1});
  await bootstrap.query('CREATE DATABASE contextline_test');await bootstrap.end();
  const admin=new pg.Pool({...config,database:'contextline_test',max:4});
  await migrateRegistry(admin);
  await admin.query("CREATE ROLE contextline_test_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'test_app_local_only'");
  await grantRuntimeRole(admin,'contextline_test_app');
  await admin.query("CREATE TABLE test_items (tenant_id text NOT NULL,id text NOT NULL,status text NOT NULL DEFAULT 'active',PRIMARY KEY(tenant_id,id));GRANT SELECT,INSERT,UPDATE,DELETE ON test_items TO contextline_test_app");
  const app=new pg.Pool({host:'127.0.0.1',port,user:'contextline_test_app',password:'test_app_local_only',database:'contextline_test',max:12,connectionTimeoutMillis:3000,statement_timeout:10000});
  const registry=new PostgresRegistry(app),ctx=new ContextLine(registry);
  return {admin,app,registry,ctx,version:(await admin.query('SHOW server_version')).rows[0].server_version as string,async cleanup(){await app.end();await admin.end();await cluster.stop();await rm(dataDir,{recursive:true,force:true});}};
}
