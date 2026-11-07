import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AllowCache,ContextLine,ContextLineError,lifecycleActionFor,eventScope,retryDelayMs,RETRY_DELAYS_MS,NON_RETRYABLE_CODES,parseStorageRef } from '../packages/core/src/index.js';
import type { AccessDecision, ArtifactDependencies, ArtifactType, EventType, RegistryStore, Run, SourceState } from '../packages/core/src/index.js';
import { PostgresTableConnector,PgVectorConnector,RedisConnector } from '../packages/worker/src/index.js';
import type { Pool } from 'pg';

const root:SourceState={id:'s1',version:1,status:'active',isCurrent:true};
class FakeRegistry implements RegistryStore {
  records=new Map<string,ArtifactDependencies>();decisions:AccessDecision[]=[];runs=new Map<string,Run>();
  quarantine:{tenantId:string;hits:unknown[]}[]=[];
  async ensureSource():Promise<void>{}
  async registerDerivation():Promise<void>{}
  async lookupArtifacts(_t:string,refs:{id:string;version:number}[]){return refs.flatMap(r=>this.records.get(JSON.stringify([r.id,r.version]))??[]);}
  async beginRun(tenantId:string,principal:string){const run={id:randomUUID(),tenantId,principal};this.runs.set(run.id,run);return run;}
  async recordDecisions(_run:Run,decisions:AccessDecision[]){this.decisions.push(...decisions);}
  async recordSourceEvent():Promise<any>{return {id:randomUUID()};}
  async recordQuarantineHits(tenantId:string,hits:unknown[]){this.quarantine.push({tenantId,hits});}
  add(id:string,sources:SourceState[]=[root]){this.records.set(JSON.stringify([id,1]),{artifact:{id,version:1,type:'embedding',connectorId:'test',storageRef:id,tenantId:'t',status:'active',ownerPrincipal:null,createdAt:'',updatedAt:''},sources});}
}
const allow=async(req:{sources:{id:string}[]})=>Object.fromEntries(req.sources.map(s=>[s.id,true]));

test('the source-wide action matrix matches blueprint A exactly',()=>{
  const types:ArtifactType[]=['embedding','cache','summary','memory'];
  const row=(event:EventType,memory:'flag'|'invalidate'|'delete'='flag')=>types.map(t=>lifecycleActionFor(event,t,memory));
  assert.deepEqual(row('document_deleted'),['delete','delete','delete','delete']);
  assert.deepEqual(row('gdpr_erasure_requested'),['delete','delete','delete','delete']);
  assert.deepEqual(row('source_restricted'),['delete','delete','delete','flag']);
  assert.deepEqual(row('retention_expired'),['delete','delete','delete','flag']);
  assert.deepEqual(row('source_restricted','delete'),['delete','delete','delete','delete']);
  assert.deepEqual(row('document_updated'),['invalidate','delete','invalidate','invalidate']);
  assert.deepEqual(row('permission_revoked'),[null,'delete',null,'flag']);
  assert.deepEqual(row('permission_granted'),[null,null,null,null]);
  assert.deepEqual(row('source_reactivated'),[null,null,null,null]);
  assert.equal(lifecycleActionFor('gdpr_erasure_requested','memory','flag'),'delete','erasure always deletes memory');
  assert.equal(eventScope('permission_revoked'),'principal');
  assert.equal(eventScope('document_deleted'),'source_wide');
});
test('retry backoff follows the published schedule with bounded jitter',()=>{
  assert.deepEqual([...RETRY_DELAYS_MS],[1000,5000,30000,300000,1800000]);
  assert.equal(retryDelayMs(3,RETRY_DELAYS_MS,0),30000);
  assert.equal(retryDelayMs(1,RETRY_DELAYS_MS,0.1,()=>0),900);
  assert.equal(retryDelayMs(1,RETRY_DELAYS_MS,0.1,()=>1),1100);
  assert.equal(retryDelayMs(99,RETRY_DELAYS_MS,0),1800000);
  for(let i=0;i<200;i++){const value=retryDelayMs(2);assert.ok(value>=4500&&value<=5500);}
  assert.ok(NON_RETRYABLE_CODES.has('UNKNOWN_TABLE'));
  assert.ok(!NON_RETRYABLE_CODES.has('VERIFICATION_FAILED'),'a lying store must still be retried');
});
test('storage references parse canonical, legacy, and connector-specific forms',()=>{
  assert.deepEqual(parseStorageRef('pgvector:chunks:chunk-1'),{connector:'pgvector',target:'chunks',recordId:'chunk-1'});
  assert.deepEqual(parseStorageRef('redis:answers:t:answer:1'),{connector:'redis',target:'answers',recordId:'t:answer:1'});
  assert.deepEqual(parseStorageRef('items/row-1'),{connector:null,target:'items',recordId:'row-1'});
  assert.deepEqual(parseStorageRef('chunk-1'),{connector:null,target:null,recordId:'chunk-1'});
  assert.throws(()=>parseStorageRef(''),{code:'INVALID_STORAGE_REFERENCE'});
  assert.throws(()=>parseStorageRef('items/a/b'),{code:'INVALID_STORAGE_REFERENCE'});
  assert.throws(()=>parseStorageRef('bad\u0000ref'),{code:'INVALID_STORAGE_REFERENCE'});
});
test('the allow cache is allow-only, bounded, expiring, and purged per source',async()=>{
  assert.throws(()=>new AllowCache({ttlMs:30001}),{code:'INVALID_CONFIG'});
  assert.throws(()=>new AllowCache({ttlMs:0}),{code:'INVALID_CONFIG'});
  const cache=new AllowCache({ttlMs:5,maxEntries:2});
  cache.set('t','alice','s1',false);assert.equal(cache.get('t','alice','s1'),false);
  cache.set('t','alice','s1',true);assert.equal(cache.get('t','alice','s1'),true);
  assert.equal(cache.get('t','bob','s1'),false,'cache keys include the principal');
  cache.set('t','alice','s2',true);cache.set('t','alice','s3',true);assert.ok(cache.size<=2);
  cache.set('t','alice','s4',true);cache.purgeSource('t','s4');assert.equal(cache.get('t','alice','s4'),false);
  cache.set('t','alice','s5',true);await new Promise(r=>setTimeout(r,12));assert.equal(cache.get('t','alice','s5'),false);
});
test('a cached allow never overrides registry lifecycle state',async()=>{
  const registry=new FakeRegistry();registry.add('a');
  const ctx=new ContextLine(registry,{authCache:{enabled:true,ttlMs:1000}});
  const run=await ctx.beginRun('t','alice');
  assert.equal((await ctx.filterAuthorized({run,candidates:[{artifactId:'a'}],authorize:allow})).length,1);
  registry.add('a',[{...root,status:'revoked'}]);
  assert.equal((await ctx.filterAuthorized({run,candidates:[{artifactId:'a'}],authorize:allow})).length,0);
  assert.equal(registry.decisions.at(-1)?.reason,'source_revoked');
  await ctx.close();
});
test('the auth cache removes repeat callback calls and is off by default',async()=>{
  for(const enabled of [false,true]){
    const registry=new FakeRegistry();registry.add('a');registry.add('b');
    const ctx=new ContextLine(registry,{authCache:{enabled,ttlMs:1000}});
    const run=await ctx.beginRun('t','alice');
    let calls=0;const authorize=async(req:{sources:{id:string}[]})=>{calls++;return allow(req);};
    await ctx.filterAuthorized({run,candidates:[{artifactId:'a'},{artifactId:'b'}],authorize});
    await ctx.filterAuthorized({run,candidates:[{artifactId:'a'},{artifactId:'b'}],authorize});
    assert.equal(calls,enabled?1:2);
    await ctx.close();
  }
});
test('per-source authorization mode calls once per unique source and still fails closed',async()=>{
  const registry=new FakeRegistry();registry.add('a');registry.add('b',[root,{...root,id:'s2'}]);
  const ctx=new ContextLine(registry);const run=await ctx.beginRun('t','alice');
  const seen:string[]=[];
  const result=await ctx.filterAuthorized({run,candidates:[{artifactId:'a'},{artifactId:'b'}],authorizeMode:'per-source',authorize:async req=>{seen.push(req.sources.map(s=>s.id).join(','));return allow(req);}});
  assert.deepEqual(seen.sort(),['s1','s2']);assert.equal(result.length,2);
  const denied=await ctx.filterAuthorized({run,candidates:[{artifactId:'b'}],authorizeMode:'per-source',authorize:async req=>req.sources[0]!.id==='s1'?{s1:true}:new Promise(resolve=>setTimeout(()=>resolve({s2:true}),40)),timeoutMs:10});
  assert.equal(denied.length,0);
  await ctx.close();
});
test('quarantine hits are buffered and flushed in one bulk call',async()=>{
  const registry=new FakeRegistry();
  const ctx=new ContextLine(registry,{quarantineFlush:{intervalMs:60000,maxItems:100}});
  const run=await ctx.beginRun('t','alice');
  for(let i=0;i<4;i++)await ctx.filterAuthorized({run,candidates:[{artifactId:'unknown'}],authorize:allow,unregisteredPolicy:'quarantine'});
  assert.equal(registry.quarantine.length,0);
  await ctx.flushQuarantine();
  assert.equal(registry.quarantine.length,1);
  assert.deepEqual(registry.quarantine[0]!.hits,[{artifactId:'unknown',artifactVersion:1,count:4}]);
  await ctx.filterAuthorized({run,candidates:[{artifactId:'unknown'}],authorize:allow,unregisteredPolicy:'quarantine'});
  await ctx.close();
  assert.equal(registry.quarantine.length,2,'close flushes the buffer');
});
test('the quarantine buffer flushes when it reaches its item threshold',async()=>{
  const registry=new FakeRegistry();
  const ctx=new ContextLine(registry,{quarantineFlush:{intervalMs:60000,maxItems:2}});
  const run=await ctx.beginRun('t','alice');
  await ctx.filterAuthorized({run,candidates:[{artifactId:'u1'},{artifactId:'u2'}],authorize:allow,unregisteredPolicy:'quarantine'});
  await ctx.close();
  assert.equal(registry.quarantine.length,1);
  assert.equal((registry.quarantine[0]!.hits as unknown[]).length,2);
});
test('memory invalidation is a review flag and pgvector falls back to deletion',async()=>{
  const calls:{sql:string;values:unknown[]|undefined}[]=[];
  const pool={query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});return {rowCount:0,rows:[]};}} as unknown as Pool;
  const table=new PostgresTableConnector(pool,{memories:{table:'memories',statusColumn:'status'}});
  await table.invalidate('memories/m1',{tenantId:'t',artifactType:'memory'});
  assert.equal(calls[0]!.values?.[2],'pending_review');
  await table.invalidate('memories/m2',{tenantId:'t',artifactType:'summary'});
  assert.equal(calls[1]!.values?.[2],'stale');
  const vectors=new PgVectorConnector(pool,{table:'vectors'});
  await vectors.invalidate('chunk-1',{tenantId:'t',artifactType:'embedding'});
  assert.match(calls[2]!.sql,/^DELETE FROM/);
  assert.equal(await vectors.verify('chunk-1',{tenantId:'t'},'invalidated'),true);
  const canonical=new PostgresTableConnector(pool,{chunks:{table:'chunks'}});
  await canonical.delete('postgres:chunks:row-9',{tenantId:'t'});
  assert.deepEqual(calls.at(-1)!.values,['row-9','t']);
});
test('Redis invalidation deletes by default and accepts canonical references',async()=>{
  let value:string|null='answer';const deleted:string[]=[];
  const client={del:async(key:string)=>{deleted.push(key);value=null;return 1;},get:async()=>value,eval:async()=>{throw new Error('must not be used');},ping:async()=>'PONG'};
  const connector=new RedisConnector(client);
  await connector.invalidate('redis:answers:t:answer:1',{tenantId:'t'});
  assert.deepEqual(deleted,['t:answer:1']);
  assert.equal(await connector.verify('t:answer:1',{tenantId:'t'},'invalidated'),true);
  assert.throws(()=>new RedisConnector(client,{invalidationMode:'expire' as any}),{code:'INVALID_CONNECTOR_CONFIGURATION'});
});
test('configuration errors keep stable codes',()=>{
  assert.throws(()=>new ContextLine(new FakeRegistry(),{authCache:{enabled:true,ttlMs:60000}}),ContextLineError);
  assert.throws(()=>new ContextLine(new FakeRegistry(),{quarantineFlush:{maxItems:0}}),{code:'INVALID_CONFIG'});
});
