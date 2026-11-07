import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LocalPostgres } from './local-postgres.js';
import pg from 'pg';
import { ContextLine, PostgresRegistry, createPool, grantRuntimeRole, migrateRegistry } from '@contextline/core';
import type { SourceRef } from '@contextline/core';
import { LifecycleWorker, PostgresTableConnector } from '@contextline/worker';
import type { StorageConnector } from '@contextline/worker';
import { handleRequest } from './http.js';

export const TENANTS = ['acme-corp','other-corp'] as const;
export const REVENUE = 'doc:q3-revenue-projections';
export const HANDBOOK = 'doc:employee-handbook';
export const DEMO_QUESTION = 'What were the Q3 revenue projections?';
export interface DemoOptions { dataDir?: string | undefined; databasePort?: number | undefined; port?: number | undefined; host?: string | undefined }
export async function freePort(): Promise<number> {
  const server=createServer();
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const address=server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
export class DemoApp {
  readonly registry!: PostgresRegistry;
  readonly ctx!: ContextLine;
  readonly worker!: LifecycleWorker;
  readonly appPool!: pg.Pool;
  private admin!: pg.Pool;
  private cluster!: LocalPostgres;
  private server: Server | null = null;
  private started=false;
  workerEnabled=true;
  outage=false;
  port=0;
  readonly diagnostics: { at: string; code: string; operation: string; tenantId: string }[]=[];
  constructor(readonly options: DemoOptions={}) {}
  async start(): Promise<void> {
    if (this.started) return;
    const dataDir=this.options.dataDir ?? fileURLToPath(new URL('../../../.contextline/demo-db',import.meta.url));
    await mkdir(dataDir,{recursive:true});
    let exists=true; await access(`${dataDir}/PG_VERSION`).catch(() => {exists=false;});
    const databasePort=this.options.databasePort ?? Number(process.env.DEMO_DATABASE_PORT ?? 55432);
    this.cluster=new LocalPostgres({databaseDir:dataDir,password:'contextline_local_only',port:databasePort});
    if (!exists) await this.cluster.initialise();
    await this.cluster.start();
    const bootstrap=new pg.Pool({host:'127.0.0.1',port:databasePort,user:'postgres',password:'contextline_local_only',database:'postgres',max:1});
    try {
      const found=await bootstrap.query('SELECT 1 FROM pg_database WHERE datname=$1',['contextline_demo']);
      if (!found.rowCount) await bootstrap.query('CREATE DATABASE contextline_demo');
    } finally {await bootstrap.end();}
    this.admin=new pg.Pool({host:'127.0.0.1',port:databasePort,user:'postgres',password:'contextline_local_only',database:'contextline_demo',max:3,connectionTimeoutMillis:3000});
    await migrateRegistry(this.admin);
    await this.admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='contextline_demo_app') THEN CREATE ROLE contextline_demo_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'contextline_demo_local_only'; END IF; END $$`);
    await grantRuntimeRole(this.admin,'contextline_demo_app');
    await this.admin.query(`
      CREATE TABLE IF NOT EXISTS demo_acl (tenant_id text NOT NULL,principal text NOT NULL,source_id text NOT NULL,PRIMARY KEY(tenant_id,principal,source_id));
      CREATE TABLE IF NOT EXISTS demo_chunks (tenant_id text NOT NULL,id text NOT NULL,text text NOT NULL,PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS demo_cache (tenant_id text NOT NULL,id text NOT NULL,text text NOT NULL,status text NOT NULL DEFAULT 'active',PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS demo_summaries (tenant_id text NOT NULL,id text NOT NULL,text text NOT NULL,status text NOT NULL DEFAULT 'active',PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS demo_memories (tenant_id text NOT NULL,id text NOT NULL,text text NOT NULL,status text NOT NULL DEFAULT 'active',PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS demo_state (tenant_id text PRIMARY KEY,seeded boolean NOT NULL DEFAULT true);
      GRANT SELECT,INSERT,UPDATE,DELETE ON demo_acl,demo_chunks,demo_cache,demo_summaries,demo_memories,demo_state TO contextline_demo_app;
    `);
    (this as {appPool:pg.Pool}).appPool=createPool({host:'127.0.0.1',port:databasePort,user:'contextline_demo_app',password:'contextline_demo_local_only',database:'contextline_demo',max:8,connectionTimeoutMillis:2000,statement_timeout:5000});
    (this as {registry:PostgresRegistry}).registry=new PostgresRegistry(this.appPool);
    const diagnostic=(d: {code:string;operation:string;tenantId:string}) => {this.diagnostics.push({...d,at:new Date().toISOString()});if(this.diagnostics.length>100)this.diagnostics.shift();};
    (this as {ctx:ContextLine}).ctx=new ContextLine(this.registry,{onDiagnostic:diagnostic});
    const tables={
      'demo-chunks':{table:'demo_chunks',schema:'public'},
      'demo-cache':{table:'demo_cache',schema:'public',statusColumn:'status'},
      'demo-summaries':{table:'demo_summaries',schema:'public',statusColumn:'status'},
      'demo-memories':{table:'demo_memories',schema:'public',statusColumn:'status'},
    };
    const connectors: Record<string,StorageConnector>={};
    for (const [id,config] of Object.entries(tables)) {
      const actual=new PostgresTableConnector(this.appPool,{[id]:config});
      connectors[id]={
        type:actual.type,
        delete:async (ref,context) => {if(this.outage)throw new Error('Simulated outage');await actual.delete(ref,context);},
        invalidate:async (ref,context) => {if(this.outage)throw new Error('Simulated outage');await actual.invalidate(ref,context);},
        verify:(ref,context,expected) => actual.verify(ref,context,expected),
        healthCheck:async () => this.outage?{healthy:false,latencyMs:0}:actual.healthCheck(),
      };
    }
    (this as {worker:LifecycleWorker}).worker=new LifecycleWorker({registry:this.registry,connectors,tenants:[...TENANTS],intervalMs:250,batchSize:20,retryDelaysMs:[500,1000,2000,4000,8000],onDiagnostic:diagnostic});
    for(const tenant of TENANTS) await this.seed(tenant);
    this.worker.start();
    this.server=createHttpServer((req,res) => {void handleRequest(this,req,res);});
    const port=this.options.port ?? Number(process.env.PORT ?? 3000);
    const host=this.options.host ?? '0.0.0.0';
    await new Promise<void>((resolve,reject) => {this.server!.once('error',reject);this.server!.listen(port,host,resolve);});
    const address=this.server.address(); this.port=typeof address==='object'&&address?address.port:port;
    this.started=true;
  }
  async stop(): Promise<void> {
    if(this.worker)await this.worker.stop();
    if(this.server)await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if(this.appPool)await this.appPool.end();
    if(this.admin)await this.admin.end();
    if(this.cluster)await this.cluster.stop();
    this.started=false;
  }
  async setWorker(enabled: boolean): Promise<void> {this.workerEnabled=enabled;if(enabled)this.worker.start();else await this.worker.stop();}
  async seed(tenant: string): Promise<void> {
    const state=await this.appPool.query('SELECT seeded FROM demo_state WHERE tenant_id=$1',[tenant]);
    if(state.rowCount)return;
    const revenue={id:REVENUE,version:1},handbook={id:HANDBOOK,version:1};
    await this.ctx.ensureSource(tenant,revenue);await this.ctx.ensureSource(tenant,handbook);
    await this.appPool.query('INSERT INTO demo_acl VALUES ($1,$2,$3),($1,$2,$5),($1,$4,$5) ON CONFLICT DO NOTHING',[tenant,'alice',REVENUE,'bob',HANDBOOK]);
    const fact=tenant==='acme-corp'?'Q3 revenue projection: $12.4M. SYNTHETIC DEMO DATA.':'Q3 revenue projection: €2.1M. OTHER TENANT — SYNTHETIC DEMO DATA.';
    const handbookFact='Employee handbook: request leave through the people portal.';
    const artifacts: {id:string;type:'embedding'|'cache'|'summary'|'memory';connectorId:string;storageRef:string}[]=[];
    const chunks: {id:string;text:string}[]=[];
    for(let i=0;i<(tenant==='acme-corp'?12:2);i++) {
      const id=`embedding:${tenant}:${i+1}`;artifacts.push({id,type:'embedding',connectorId:'demo-chunks',storageRef:`demo-chunks/${id}`});chunks.push({id,text:`${fact} Retrieval chunk ${i+1}.`});
    }
    for(let i=0;i<(tenant==='acme-corp'?2:1);i++) {
      const id=`embedding:handbook:${tenant}:${i+1}`;artifacts.push({id,type:'embedding',connectorId:'demo-chunks',storageRef:`demo-chunks/${id}`});chunks.push({id,text:`${handbookFact} Section ${i+1}.`});
    }
    await this.ctx.registerDerivation({tenantId:tenant,sources:[revenue],artifacts:artifacts.filter(a=>a.type==='embedding'&&!a.id.includes('handbook'))});
    await this.ctx.registerDerivation({tenantId:tenant,sources:[handbook],artifacts:artifacts.filter(a=>a.id.includes('handbook'))});
    for(const chunk of chunks)await this.appPool.query('INSERT INTO demo_chunks (tenant_id,id,text) VALUES ($1,$2,$3)',[tenant,chunk.id,chunk.text]);
    if(tenant==='acme-corp') {
      const answer=`${fact} ${handbookFact}`;
      const cache=Array.from({length:3},(_,i)=>({id:`cache:q3:${i+1}`,type:'cache' as const,connectorId:'demo-cache',storageRef:`demo-cache/cache:q3:${i+1}`}));
      await this.ctx.registerDerivation({tenantId:tenant,sources:[revenue,handbook],artifacts:cache});
      for(const entry of cache)await this.appPool.query('INSERT INTO demo_cache (tenant_id,id,text) VALUES ($1,$2,$3)',[tenant,entry.id,answer]);
      const summary={id:'summary:q3',type:'summary' as const,connectorId:'demo-summaries',storageRef:'demo-summaries/summary:q3'};
      await this.ctx.registerDerivation({tenantId:tenant,sources:[revenue],artifacts:[summary],derivedFrom:[{id:artifacts[0]!.id}]});
      await this.appPool.query('INSERT INTO demo_summaries (tenant_id,id,text) VALUES ($1,$2,$3)',[tenant,summary.id,fact]);
      const memories=[1,2].map(i=>({id:`memory:agent-fact-${i}`,type:'memory' as const,connectorId:'demo-memories',storageRef:`demo-memories/memory:agent-fact-${i}`}));
      await this.ctx.registerDerivation({tenantId:tenant,sources:[revenue],artifacts:memories,derivedFrom:[{id:summary.id}]});
      for(const memory of memories)await this.appPool.query('INSERT INTO demo_memories (tenant_id,id,text) VALUES ($1,$2,$3)',[tenant,memory.id,`${fact} Agent fact ${memory.id.slice(-1)}.`]);
    }
    await this.appPool.query('INSERT INTO demo_state (tenant_id) VALUES ($1)',[tenant]);
  }
  async reset(tenant: string): Promise<void> {
    const wasRunning=this.workerEnabled;
    await this.setWorker(false);
    try {
    for(const [pool,role] of [[this.admin,'contextline_owner'],[this.appPool,'contextline_demo_app']] as const) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');await client.query("SELECT set_config('app.current_tenant',$1,true)",[tenant]);
        if(role==='contextline_owner') {
          for(const table of ['lifecycle_jobs','access_decisions','lifecycle_events','access_runs','quarantine_manifest','dependencies','artifacts','sources'])await client.query(`DELETE FROM contextline.${table} WHERE tenant_id=$1`,[tenant]);
        }
        for(const table of ['demo_acl','demo_chunks','demo_cache','demo_summaries','demo_memories','demo_state'])await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    await this.seed(tenant);
    } finally { await this.setWorker(wasRunning); }
  }
  async authorize(tenantId: string,principal: string,sources: SourceRef[]): Promise<Record<string,boolean>> {
    const result=await this.appPool.query('SELECT source_id FROM demo_acl WHERE tenant_id=$1 AND principal=$2 AND source_id=ANY($3::text[])',[tenantId,principal,sources.map(s=>s.id)]);
    const allowed=new Set(result.rows.map(r=>r.source_id));return Object.fromEntries(sources.map(s=>[s.id,allowed.has(s.id)]));
  }
  async query(tenant: string,principal: string,question: string,useCache=true): Promise<Record<string,unknown>> {
    const run=await this.ctx.beginRun(tenant,principal);
    const authorize=(request: {tenantId:string;principal:string;sources:SourceRef[]})=>this.authorize(request.tenantId,request.principal,request.sources);
    const isRevenue=/revenue|q3|projection/i.test(question),isHandbook=/handbook|leave|employee/i.test(question);
    if(useCache&&isRevenue&&tenant==='acme-corp') {
      const cached=await this.appPool.query("SELECT id,text FROM demo_cache WHERE tenant_id=$1 AND id='cache:q3:1'",[tenant]);
      if(cached.rowCount) {
        const allowed=await this.ctx.assertCanServe({tenantId:tenant,principal,artifact:cached.rows[0].id,authorize,run});
        if(allowed)return {runId:run.id,mode:'cache',answer:cached.rows[0].text,authorizedCount:1,cacheHit:true,disclaimer:'Cached synthetic answer; every root source was reauthorized for this principal.'};
      }
    }
    const rows=await this.appPool.query(`SELECT id,text,'embedding' AS kind FROM demo_chunks WHERE tenant_id=$1
      UNION ALL SELECT id,text,'summary' FROM demo_summaries WHERE tenant_id=$1
      UNION ALL SELECT id,text,'memory' FROM demo_memories WHERE tenant_id=$1`,[tenant]);
    const candidates=rows.rows.filter(r=>(isRevenue&&/Q3 revenue/.test(r.text))||(isHandbook&&/handbook/.test(r.text))||(!isRevenue&&!isHandbook)).slice(0,30).map(r=>({artifactId:r.id as string,content:r.text as string,kind:r.kind as string}));
    const authorized=await this.ctx.filterAuthorized({run,candidates,authorize});
    const facts=[...new Set(authorized.map(a=>a.artifact.content.replace(/ Retrieval chunk \d+\.| Section \d+\.| Agent fact \d+\./g,'')))];
    return {runId:run.id,mode:'retrieval',answer:facts.length?facts.join(' '):'No authorized context is available for this request.',authorizedCount:authorized.length,candidateCount:candidates.length,cacheHit:false,sourceRefs:[...new Map(authorized.flatMap(a=>a.sourceRefs).map(s=>[s.id,s])).values()],disclaimer:'Deterministic retrieval simulation; no LLM, embedding model, or external API is called.'};
  }
  async action(tenant: string,action: string,payload: Record<string,unknown>): Promise<Record<string,unknown>> {
    const sourceId=typeof payload.sourceId==='string'?payload.sourceId:REVENUE;
    if(![REVENUE,HANDBOOK].includes(sourceId))throw new Error('INVALID_SOURCE');
    if(action==='reset'){await this.reset(tenant);return {reset:true};}
    if(action==='toggle-worker'){await this.setWorker(!this.workerEnabled);return {workerEnabled:this.workerEnabled};}
    if(action==='toggle-outage'){this.outage=!this.outage;return {outage:this.outage};}
    if(action==='process-queue'){const processed=await this.worker.tick();return {processed};}
    if(action==='retry-event'){if(typeof payload.eventId!=='string')throw new Error('INVALID_EVENT');return {retried:await this.registry.retryEvent(tenant,payload.eventId)};}
    if(action==='acknowledge-review'){if(typeof payload.jobId!=='string')throw new Error('INVALID_EVENT');const acknowledged=await this.registry.acknowledgeReview(tenant,payload.jobId,'demo-operator');return {acknowledged,note:'Review acknowledged. The artifact remains blocked; use source erasure if deletion is required.'};}
    if(action==='grant-principal'||action==='revoke-principal') {
      const principal=payload.principal==='bob'?'bob':'alice';
      // Change authoritative demo ACL first, then record the audit event. No SDK auth cache exists.
      if(action==='grant-principal')await this.appPool.query('INSERT INTO demo_acl VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[tenant,principal,sourceId]);
      else await this.appPool.query('DELETE FROM demo_acl WHERE tenant_id=$1 AND principal=$2 AND source_id=$3',[tenant,principal,sourceId]);
      const event=await this.ctx.recordSourceEvent({tenantId:tenant,sourceId,event:action==='grant-principal'?'permission_granted':'permission_revoked',affectedPrincipals:[principal],idempotencyKey:randomUUID()});
      return {event,note:'Principal-specific change: shared artifacts are preserved. Live authorization denies the affected principal.'};
    }
    const sources=await this.registry.listSources(tenant);const current=sources.find(s=>s.id===sourceId&&s.isCurrent);
    if(!current)throw new Error('INVALID_SOURCE');
    if(action==='update-source'&&current.version>=2147483647)throw new Error('INVALID_VERSION');
    const eventTypes: Record<string,'document_deleted'|'gdpr_erasure_requested'|'source_restricted'|'source_reactivated'|'document_updated'>={ 'delete-source':'document_deleted','erase-source':'gdpr_erasure_requested','restrict-source':'source_restricted','reactivate-source':'source_reactivated','update-source':'document_updated' };
    const eventType=eventTypes[action];if(!eventType)throw new Error('INVALID_ACTION');
    const event=await this.ctx.recordSourceEvent({tenantId:tenant,sourceId,event:eventType,...(eventType==='document_updated'?{newVersion:current.version+1}:{}),...(eventType==='source_restricted'?{memoryAction:'flag' as const}:{})});
    return {event,note:'The registry blocks affected artifacts immediately. Storage cleanup is asynchronous and verified.'};
  }
  async snapshot(tenant: string): Promise<Record<string,unknown>> {
    const [sources,artifacts,events,jobs,decisions,acl,counts,queue]=await Promise.all([
      this.registry.listSources(tenant),this.registry.listArtifacts(tenant),this.registry.listEvents(tenant,20),this.registry.listJobs(tenant),this.registry.listDecisions(tenant),this.appPool.query('SELECT principal,source_id FROM demo_acl WHERE tenant_id=$1 ORDER BY principal,source_id',[tenant]),
      this.appPool.query(`SELECT (SELECT count(*) FROM demo_chunks WHERE tenant_id=$1)::int AS chunks,(SELECT count(*) FROM demo_cache WHERE tenant_id=$1 AND status='active')::int AS cache,(SELECT count(*) FROM demo_summaries WHERE tenant_id=$1 AND status='active')::int AS summaries,(SELECT count(*) FROM demo_memories WHERE tenant_id=$1 AND status='active')::int AS memories`,[tenant]),this.registry.queueStats(tenant),
    ]);
    return {tenant,sources,artifacts,events,jobs,decisions,grants:acl.rows,storageCounts:counts.rows[0],queue,workerEnabled:this.workerEnabled,outage:this.outage,diagnostics:this.diagnostics.filter(d=>d.tenantId===tenant).slice(-10),synthetic:true,updatedAt:new Date().toISOString()};
  }
}
