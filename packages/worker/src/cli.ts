#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgresRegistry } from '@contextline/core';
import { LifecycleWorker,PgVectorConnector,PostgresTableConnector,RedisConnector } from './index.js';
import type { StorageConnector,TableConfig } from './connectors.js';

function required(name:string):string{const value=process.env[name];if(!value)throw new Error(`Missing ${name}`);return value;}
function integer(name:string,fallback:number):number{const value=process.env[name]===undefined?fallback:Number(process.env[name]);if(!Number.isSafeInteger(value))throw new Error(`Invalid ${name}`);return value;}
const pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:integer('CONTEXTLINE_POOL_SIZE',10),connectionTimeoutMillis:2000,statement_timeout:10000});
const redisClients:Redis[]=[];
let server:ReturnType<typeof createServer>|null=null;
let worker:LifecycleWorker|undefined;
try {
  const file=required('CONTEXTLINE_CONNECTORS_FILE');const raw=await readFile(file,'utf8');if(raw.length>65536)throw new Error('Connector config too large');
  const config=JSON.parse(raw) as {connectors:{id:string;type:string;table?:string;schema?:string;idColumn?:string;tenantColumn?:string;statusColumn?:string;requireTenantPrefix?:boolean;tables?:Record<string,TableConfig>}[]};
  if(!Array.isArray(config.connectors)||!config.connectors.length||config.connectors.length>100)throw new Error('Invalid connectors array');
  const connectors:Record<string,StorageConnector>={};
  for(const entry of config.connectors){
    if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id)||Object.hasOwn(connectors,entry.id))throw new Error('Invalid or duplicate connector ID');
    if(entry.type==='redis'){
      const client=new Redis(required('REDIS_URL'),{maxRetriesPerRequest:1,enableOfflineQueue:false,connectTimeout:5000});
      client.on('error',()=>console.error(JSON.stringify({level:'error',code:'REDIS_CONNECTION_ERROR'})));
      redisClients.push(client);connectors[entry.id]=new RedisConnector(client,{requireTenantPrefix:entry.requireTenantPrefix ?? true});
    }else if(entry.type==='pgvector'){
      if(!entry.table)throw new Error('pgvector connector requires table');
      const table:TableConfig={table:entry.table};
      if(entry.schema!==undefined)table.schema=entry.schema;if(entry.idColumn!==undefined)table.idColumn=entry.idColumn;if(entry.tenantColumn!==undefined)table.tenantColumn=entry.tenantColumn;
      connectors[entry.id]=new PgVectorConnector(pool,table);
    }else if(entry.type==='postgres'){
      if(!entry.tables)throw new Error('postgres connector requires tables');connectors[entry.id]=new PostgresTableConnector(pool,entry.tables);
    }else throw new Error('Unknown connector type');
  }
  const tenants=required('CONTEXTLINE_WORKER_TENANTS').split(',').map(t=>t.trim()).filter(Boolean);
  const registry=new PostgresRegistry(pool,{schema:process.env.CONTEXTLINE_SCHEMA ?? 'contextline'});
  worker=new LifecycleWorker({registry,connectors,tenants,batchSize:integer('CONTEXTLINE_BATCH_SIZE',20),concurrency:integer('CONTEXTLINE_CONCURRENCY',4),intervalMs:integer('CONTEXTLINE_INTERVAL_MS',500),leaseMs:integer('CONTEXTLINE_LEASE_MS',60000),operationTimeoutMs:integer('CONTEXTLINE_OPERATION_TIMEOUT_MS',10000),maxAttempts:integer('CONTEXTLINE_MAX_ATTEMPTS',6),onDiagnostic:d=>console.error(JSON.stringify({level:'error',...d}))});
  const port=integer('CONTEXTLINE_METRICS_PORT',9090);
  server=createServer((req,res)=>{void (async()=>{
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/metrics'){const text=await worker!.metrics();res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});res.end(text);}
    else if(req.url==='/health'){await registry.healthCheck();const health=await Promise.all(Object.values(connectors).map(c=>c.healthCheck()));const healthy=health.every(h=>h.healthy);res.writeHead(healthy?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({healthy}));}
    else {res.writeHead(404);res.end();}
  })().catch(()=>{if(!res.headersSent)res.writeHead(503);res.end('{"healthy":false}');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(port,'0.0.0.0',resolve);});
  console.log(JSON.stringify({level:'info',message:'ContextLine worker started',metricsPort:port,tenants}));
  worker.start();
} catch {
  console.error('Worker startup failed. Check DATABASE_URL, tenant list, connector JSON, and Redis configuration.');
  await worker?.stop();await Promise.all(redisClients.map(c=>c.quit().catch(()=>c.disconnect())));await pool.end();process.exitCode=1;
}
let stopping=false;
async function stop():Promise<void>{if(stopping)return;stopping=true;await worker?.stop();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await Promise.all(redisClients.map(c=>c.quit().catch(()=>c.disconnect())));await pool.end();}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
