import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './postgres-fixture.js';
import { migrateRegistry,grantRuntimeRole } from '../packages/core/src/index.js';
import type { ArtifactType, SourceRef } from '../packages/core/src/index.js';
import { LifecycleWorker,PostgresTableConnector } from '../packages/worker/src/index.js';
import type { StorageConnector } from '../packages/worker/src/index.js';
let f:Awaited<ReturnType<typeof postgresFixture>>;
const tenant='integration';
before(async()=>{f=await postgresFixture();});
after(async()=>{await f?.cleanup();});
const allow=async(req:{sources:SourceRef[]})=>Object.fromEntries(req.sources.map(s=>[s.id,true]));
const source=(id:string,version=1):SourceRef=>({id,version});
async function seed(t=tenant,id=randomUUID(),type:ArtifactType='embedding',roots:SourceRef[]=[source(`source:${id}`)]){
  for(const s of roots)await f.ctx.ensureSource(t,s);
  const artifact={id:`artifact:${id}`,type,connectorId:'test-items',storageRef:`test-items/artifact:${id}`};
  await f.ctx.registerDerivation({tenantId:t,sources:roots,artifacts:[artifact]});
  await f.app.query('INSERT INTO test_items (tenant_id,id) VALUES ($1,$2)',[t,artifact.id]);
  return {artifact,roots};
}
function connector():PostgresTableConnector{return new PostgresTableConnector(f.app,{'test-items':{table:'test_items',statusColumn:'status'}});}
function worker(t=tenant,c:StorageConnector=connector()){return new LifecycleWorker({registry:f.registry,connectors:{'test-items':c},tenants:[t],retryDelaysMs:[0,0,0],operationTimeoutMs:100,leaseMs:5000,batchSize:10});}
async function item(t:string,id:string){return (await f.app.query('SELECT * FROM test_items WHERE tenant_id=$1 AND id=$2',[t,id])).rows[0];}
async function serve(id:string){const run=await f.ctx.beginRun(tenant,'alice');return f.ctx.filterAuthorized({run,candidates:[{artifactId:id}],authorize:allow});}

test('real PostgreSQL migrations are idempotent and force RLS on every core table',async()=>{
  await migrateRegistry(f.admin);await migrateRegistry(f.admin);
  const result=await f.admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='contextline'::regnamespace AND relkind='r' AND relname <> 'schema_migrations'");
  assert.equal(result.rowCount,7);for(const row of result.rows){assert.equal(row.relrowsecurity,true,row.relname);assert.equal(row.relforcerowsecurity,true,row.relname);}
});
test('runtime role cannot bypass RLS, delete audit rows, or mutate migration history',async()=>{
  await seed();assert.equal((await f.app.query('SELECT * FROM contextline.artifacts')).rowCount,0);
  await assert.rejects(f.app.query('DELETE FROM contextline.access_decisions'),{code:'42501'});
  await assert.rejects(f.app.query('UPDATE contextline.access_decisions SET allowed=true'),{code:'42501'});
  await assert.rejects(f.app.query('SELECT * FROM contextline.schema_migrations'),{code:'42501'});
  await assert.rejects(grantRuntimeRole(f.admin,'postgres'),{code:'UNSAFE_ROLE'});
});
test('RLS rejects cross-tenant writes and composite foreign keys reject cross-tenant edges',async()=>{
  const a='rls-a',b='rls-b',id='same-id';const one=await seed(a,id),two=await seed(b,id);
  assert.equal((await f.registry.lookupArtifacts(a,[{id:one.artifact.id,version:1}]))[0]!.artifact.tenantId,a);
  assert.equal((await f.registry.lookupArtifacts(b,[{id:two.artifact.id,version:1}]))[0]!.artifact.tenantId,b);
  await assert.rejects(f.registry.transaction(a,c=>c.query('INSERT INTO contextline.sources (tenant_id,source_id,version) VALUES ($1,$2,1)',[b,'illegal'])),{code:'42501'});
  await f.ctx.ensureSource(b,source('foreign-root'));
  await f.ctx.registerDerivation({tenantId:a,sources:one.roots,artifacts:[{id:'cross-edge-child',type:'embedding',connectorId:'test-items',storageRef:'test-items/cross-edge-child'}]});
  await assert.rejects(f.registry.transaction(a,c=>c.query('INSERT INTO contextline.dependencies (tenant_id,artifact_id,artifact_version,source_id,source_version) VALUES ($1,$2,1,$3,1)',[a,'cross-edge-child','foreign-root'])),{code:'23503'});
});
test('registration is idempotent under concurrency and immutable after commit',async()=>{
  const id=randomUUID(),s=source(`source:${id}`);await f.ctx.ensureSource(tenant,s);
  const input={tenantId:tenant,sources:[s],artifacts:[{id,type:'embedding' as const,connectorId:'test-items',storageRef:`test-items/${id}`}]};
  await Promise.all([f.ctx.registerDerivation(input),f.ctx.registerDerivation(input)]);
  assert.equal((await f.registry.listArtifacts(tenant)).filter(a=>a.id===id).length,1);
  await assert.rejects(f.ctx.registerDerivation({...input,artifacts:[{...input.artifacts[0]!,storageRef:'different'}]}),{code:'IMMUTABLE_ARTIFACT'});
  await f.ctx.ensureSource(tenant,source('other-root'));
  await assert.rejects(f.ctx.registerDerivation({...input,sources:[source('other-root')]}),{code:'IMMUTABLE_PROVENANCE'});
  await assert.rejects(f.ctx.registerDerivation({...input,sources:[source('missing-root')]}),{code:'UNKNOWN_SOURCE'});
});
test('transitive registration flattens to root sources and rejects unknown parents',async()=>{
  const parent=await seed();const id=randomUUID();
  await f.ctx.registerDerivation({tenantId:tenant,sources:[],artifacts:[{id,type:'memory',connectorId:'test-items',storageRef:`test-items/${id}`}],derivedFrom:[{id:parent.artifact.id}]});
  const record=(await f.registry.lookupArtifacts(tenant,[{id,version:1}]))[0]!;
  assert.deepEqual(record.sources.map(s=>s.id),parent.roots.map(s=>s.id));
  await assert.rejects(f.ctx.registerDerivation({tenantId:tenant,sources:[],artifacts:[{id:'orphan-child',type:'memory',connectorId:'test-items',storageRef:'test-items/orphan-child'}],derivedFrom:[{id:'missing-parent'}]}),{code:'UNKNOWN_PARENT'});
});
test('multi-source artifacts require every root and batch authorization by unique source',async()=>{
  const roots=[source('multi-a'),source('multi-b')];const {artifact}=await seed(tenant,randomUUID(),'cache',roots);const run=await f.ctx.beginRun(tenant,'alice');let calls=0;
  const result=await f.ctx.filterAuthorized({run,candidates:[{artifactId:artifact.id}],authorize:async req=>{calls++;assert.equal(req.sources.length,2);return {[req.sources[0]!.id]:true,[req.sources[1]!.id]:false};}});
  assert.equal(result.length,0);assert.equal(calls,1);assert.equal((await f.registry.listDecisions(tenant,run.id))[0]!.reason,'authorization_denied');
});
test('unknown provenance is denied and quarantine is recorded for backfill',async()=>{
  const run=await f.ctx.beginRun(tenant,'alice');const result=await f.ctx.filterAuthorized({run,candidates:[{artifactId:'unregistered'}],authorize:allow,unregisteredPolicy:'quarantine'});
  assert.equal(result.length,0);assert.equal((await f.registry.listDecisions(tenant,run.id))[0]!.reason,'quarantined');
});
test('principal revocation is audit-only and preserves shared artifacts',async()=>{
  const {artifact,roots}=await seed();const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'permission_revoked',affectedPrincipals:['alice']});
  assert.equal(event.status,'completed');assert.equal(event.affectedArtifacts,0);await worker().drain(tenant);assert.equal((await item(tenant,artifact.id)).status,'active');assert.equal((await serve(artifact.id)).length,1);
});
test('source deletion blocks immediately, then verifies every storage deletion',async()=>{
  const root=source('delete-root');const items=[await seed(tenant,randomUUID(),'embedding',[root]),await seed(tenant,randomUUID(),'cache',[root]),await seed(tenant,randomUUID(),'memory',[root])];
  const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'document_deleted'});
  assert.equal((await serve(items[0]!.artifact.id)).length,0);
  assert.equal(await worker().drain(tenant),3);
  const finished=await f.registry.getEvent(tenant,event.id);assert.equal(finished?.status,'completed');assert.equal(finished?.processedArtifacts,3);
  for(const {artifact} of items){assert.equal(await item(tenant,artifact.id),undefined);assert.equal((await f.registry.lookupArtifacts(tenant,[{id:artifact.id,version:1}]))[0]!.artifact.status,'deleted');}
  const jobs=await f.registry.listJobs(tenant,event.id);assert.ok(jobs.every(j=>j.verifiedAt&&j.attempts===1));
});
test('restriction flags memory for review, reports partial, and never serves flagged content',async()=>{
  const root=source('restrict-root');const memory=await seed(tenant,randomUUID(),'memory',[root]);const chunk=await seed(tenant,randomUUID(),'embedding',[root]);
  const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'source_restricted'});await worker().drain(tenant);
  assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'partial');assert.equal((await item(tenant,memory.artifact.id)).status,'active');assert.equal((await item(tenant,chunk.artifact.id)).status,'stale');assert.equal((await serve(memory.artifact.id)).length,0);
});
test('review acknowledgement closes the workflow but keeps the artifact blocked',async()=>{
  const root=source('review-ack-root');const {artifact}=await seed(tenant,randomUUID(),'memory',[root]);const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'source_restricted'});await worker().drain(tenant);
  const job=(await f.registry.listJobs(tenant,event.id))[0]!;assert.equal(await f.registry.acknowledgeReview(tenant,job.id,'security-operator'),true);
  assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'completed');assert.equal((await serve(artifact.id)).length,0);assert.equal((await f.registry.lookupArtifacts(tenant,[{id:artifact.id,version:1}]))[0]!.artifact.status,'pending_review');assert.equal(await f.registry.acknowledgeReview(tenant,job.id,'security-operator'),false);
});
test('GDPR-style erasure deletes memory despite the default review policy',async()=>{
  const root=source('erasure-root');const {artifact}=await seed(tenant,randomUUID(),'memory',[root]);const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'gdpr_erasure_requested'});await worker().drain(tenant);
  assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'completed');assert.equal(await item(tenant,artifact.id),undefined);
});
test('updates invalidate old versions and new artifacts bind to the new root version',async()=>{
  const old=await seed();const root=old.roots[0]!;const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'document_updated',newVersion:2});await worker().drain(tenant);
  assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'completed');assert.equal((await serve(old.artifact.id)).length,0);
  const fresh=await seed(tenant,randomUUID(),'embedding',[source(root.id,2)]);assert.equal((await serve(fresh.artifact.id)).length,1);
  await assert.rejects(f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'document_updated',newVersion:4}),{code:'INVALID_VERSION'});
});
test('false verification is retried; success alone never marks an artifact deleted',async()=>{
  const {artifact,roots}=await seed();const actual=connector();let fail=true;
  const lying:StorageConnector={type:'test',delete:async(ref,ctx)=>{if(!fail)await actual.delete(ref,ctx);},invalidate:(ref,ctx)=>actual.invalidate(ref,ctx),verify:(ref,ctx,expected)=>actual.verify(ref,ctx,expected),healthCheck:()=>actual.healthCheck()};
  const w=worker(tenant,lying);const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'document_deleted'});
  await w.tick();let jobs=await f.registry.listJobs(tenant,event.id);assert.equal(jobs[0]!.status,'retry');assert.equal(jobs[0]!.lastErrorCode,'VERIFICATION_FAILED');assert.equal((await f.registry.lookupArtifacts(tenant,[{id:artifact.id,version:1}]))[0]!.artifact.status,'active');
  fail=false;await w.drain(tenant);jobs=await f.registry.listJobs(tenant,event.id);assert.equal(jobs[0]!.status,'completed');assert.equal(jobs[0]!.attempts,2);assert.equal(jobs[0]!.history.length,2);assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'completed');
});
test('exhausted jobs enter the durable dead-letter state and can be explicitly retried',async()=>{
  const {artifact,roots}=await seed();const actual=connector();let down=true;
  const c:StorageConnector={...actual,type:'test',delete:async(ref,ctx)=>{if(down)throw new Error('secret URL');await actual.delete(ref,ctx);},invalidate:(ref,ctx)=>actual.invalidate(ref,ctx),verify:(ref,ctx,e)=>actual.verify(ref,ctx,e),healthCheck:()=>actual.healthCheck()};
  const w=worker(tenant,c);const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'document_deleted'});await f.registry.materializeNextEvent(tenant,1);await w.tick();
  assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'failed');assert.equal((await f.registry.listJobs(tenant,event.id))[0]!.lastErrorCode,'CONNECTOR_ERROR');assert.equal((await serve(artifact.id)).length,0);
  down=false;assert.equal(await f.registry.retryEvent(tenant,event.id),1);await w.drain(tenant);assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'completed');
});
test('expired leases are reclaimed and stale fencing tokens cannot commit',async()=>{
  const {roots}=await seed();const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'document_deleted'});await f.registry.materializeNextEvent(tenant);
  const old=(await f.registry.claimJobs(tenant,1,1000))[0]!;
  await f.registry.transaction(tenant,async c=>{await c.query("UPDATE contextline.lifecycle_jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2::uuid",[tenant,old.id]);});
  const fresh=(await f.registry.claimJobs(tenant,1,5000))[0]!;assert.notEqual(old.leaseToken,fresh.leaseToken);
  assert.equal(await f.registry.finishJob(old,{status:'completed',verified:true}),false);assert.equal(await f.registry.finishJob(fresh,{status:'completed',verified:true}),true);assert.equal((await f.registry.getEvent(tenant,event.id))?.status,'completed');
});
test('concurrent workers do not double-claim jobs',async()=>{
  const root=source('concurrent-root');const items=[];for(let i=0;i<8;i++)items.push(await seed(tenant,randomUUID(),'embedding',[root]));
  const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'document_deleted'});const a=worker(),b=worker();await Promise.all([a.tick(),b.tick()]);await a.drain(tenant);
  const jobs=await f.registry.listJobs(tenant,event.id);assert.equal(jobs.length,8);assert.ok(jobs.every(j=>j.status==='completed'&&j.attempts===1));for(const {artifact} of items)assert.equal(await item(tenant,artifact.id),undefined);
});
test('concurrent job completions serialize the event aggregate refresh',async()=>{
  const root=source('aggregate-refresh-root');for(let i=0;i<6;i++)await seed(tenant,`aggregate-${i}`,'embedding',[root]);
  const event=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'document_deleted'});await f.registry.materializeNextEvent(tenant);
  const jobs=await f.registry.claimJobs(tenant,6,5000);assert.equal(jobs.length,6);
  const committed=await Promise.all(jobs.map(job=>f.registry.finishJob(job,{status:'completed',verified:true})));assert.ok(committed.every(Boolean));
  const finished=await f.registry.getEvent(tenant,event.id);assert.equal(finished?.status,'completed');assert.equal(finished?.processedArtifacts,6);assert.deepEqual(finished?.details.results,{completed:6});
});
test('registration versus deletion races never leave an active post-delete derivative',async()=>{
  for(let i=0;i<5;i++){
    const root=source(`race-${i}`);await f.ctx.ensureSource(tenant,root);const id=`race-artifact-${i}`;
    const input={tenantId:tenant,sources:[root],artifacts:[{id,type:'embedding' as const,connectorId:'test-items',storageRef:`test-items/${id}`}]};
    const results=await Promise.allSettled([f.ctx.registerDerivation(input),f.ctx.recordSourceEvent({tenantId:tenant,sourceId:root.id,event:'document_deleted'})]);
    assert.equal(results[1]!.status,'fulfilled');if(results[0]!.status==='rejected')assert.equal((results[0] as PromiseRejectedResult).reason.code,'SOURCE_UNAVAILABLE');
    await worker().drain(tenant);const records=await f.registry.lookupArtifacts(tenant,[{id,version:1}]);assert.ok(records.every(r=>r.artifact.status==='deleted'));assert.equal((await serve(id)).length,0);
  }
});
test('deleted-version tombstones cannot be resurrected by registration retries',async()=>{
  const {artifact,roots}=await seed();const input={tenantId:tenant,sources:roots,artifacts:[artifact]};await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'document_deleted'});await worker().drain(tenant);
  await f.ctx.registerDerivation(input);assert.equal((await f.registry.lookupArtifacts(tenant,[{id:artifact.id,version:1}]))[0]!.artifact.status,'deleted');
  await assert.rejects(f.ctx.registerDerivation({...input,artifacts:[{...artifact,id:'new-after-delete'}]}),{code:'SOURCE_UNAVAILABLE'});
});
test('reactivation and permission grants do not resurrect invalidated artifacts',async()=>{
  const {artifact,roots}=await seed();await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'source_restricted'});await worker().drain(tenant);
  await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'source_reactivated'});await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'permission_granted',affectedPrincipals:['alice']});
  assert.equal((await serve(artifact.id)).length,0);assert.equal((await f.registry.lookupArtifacts(tenant,[{id:artifact.id,version:1}]))[0]!.artifact.status,'stale');
});
test('event idempotency is tenant-scoped and rejects changed payloads',async()=>{
  const {roots}=await seed();const input={tenantId:tenant,sourceId:roots[0]!.id,event:'permission_revoked' as const,affectedPrincipals:['alice'],idempotencyKey:'same-key'};
  const a=await f.ctx.recordSourceEvent(input),b=await f.ctx.recordSourceEvent({...input,affectedPrincipals:['alice','alice']});assert.equal(a.id,b.id);
  await assert.rejects(f.ctx.recordSourceEvent({...input,affectedPrincipals:['bob']}),{code:'IDEMPOTENCY_CONFLICT'});
  const other=await seed('other-tenant');const c=await f.ctx.recordSourceEvent({...input,tenantId:'other-tenant',sourceId:other.roots[0]!.id});assert.notEqual(c.id,a.id);
});
test('worker isolation deletes only the event tenant’s storage row',async()=>{
  const root=source('shared-source-id');const a=await seed('worker-a',randomUUID(),'embedding',[root]),b=await seed('worker-b',randomUUID(),'embedding',[root]);
  await f.ctx.recordSourceEvent({tenantId:'worker-a',sourceId:root.id,event:'document_deleted'});await worker('worker-a').drain('worker-a');
  assert.equal(await item('worker-a',a.artifact.id),undefined);assert.ok(await item('worker-b',b.artifact.id));assert.equal((await f.registry.lookupArtifacts('worker-b',[{id:b.artifact.id,version:1}]))[0]!.artifact.status,'active');
});
test('audit trails contain root references and no candidate payload',async()=>{
  const {artifact}=await seed();const run=await f.ctx.beginRun(tenant,'alice');await f.ctx.filterAuthorized({run,candidates:[{artifactId:artifact.id,content:'SECRET_DOCUMENT',prompt:'SECRET_PROMPT'}],authorize:allow});
  const decisions=await f.registry.listDecisions(tenant,run.id);assert.equal(decisions.length,1);assert.equal(decisions[0]!.principal,'alice');assert.ok(!JSON.stringify(decisions).includes('SECRET'));assert.equal(decisions[0]!.sources.length,1);
});
test('a forged run principal cannot produce an allowed response under required audit',async()=>{
  const {artifact}=await seed();const run=await f.ctx.beginRun(tenant,'alice');const result=await f.ctx.filterAuthorized({run:{...run,principal:'bob'},candidates:[{artifactId:artifact.id}],authorize:allow});assert.equal(result.length,0);
});
test('erasure events are prioritized over earlier updates',async()=>{
  const {roots}=await seed();await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'document_updated',newVersion:2});const erasure=await f.ctx.recordSourceEvent({tenantId:tenant,sourceId:roots[0]!.id,event:'gdpr_erasure_requested'});
  const claimed=await f.registry.materializeNextEvent(tenant);assert.equal(claimed?.id,erasure.id);await worker().drain(tenant);
});
test('migration checksums detect edits to applied migrations',async()=>{
  await f.admin.query("UPDATE contextline.schema_migrations SET checksum='changed'");
  try {await assert.rejects(migrateRegistry(f.admin),{code:'MIGRATION_CHANGED'});}
  finally {const {createHash}=await import('node:crypto');const {readFile}=await import('node:fs/promises');const sql=await readFile('packages/core/src/migrations/001_registry.sql');await f.admin.query('UPDATE contextline.schema_migrations SET checksum=$1',[createHash('sha256').update(sql).digest('hex')]);}
});
test('Prometheus tenant labels are escaped and queue counts are tenant-scoped',async()=>{
  const stats=await f.registry.queueStats('worker-a');assert.ok(stats.failed>=0);const text=f.registry.metricsText('a"b\\c',{processed:1,failures:2,claimed:3});assert.ok(text.includes('tenant="a\\"b\\\\c"'));assert.ok(text.includes('contextline_jobs_processed_total'));
  const combined=await new LifecycleWorker({registry:f.registry,tenants:['worker-a','worker-b'],connectors:{}}).metrics();
  for(const metric of ['contextline_worker_up','contextline_jobs_processed_total','contextline_job_failures_total','contextline_jobs_claimed_total','contextline_queue_jobs','contextline_dead_letter_jobs','contextline_review_jobs'])assert.equal(combined.split('\n').filter(l=>l===`# TYPE ${metric} ${metric.includes('_total')?'counter':'gauge'}`).length,1,metric);
});
