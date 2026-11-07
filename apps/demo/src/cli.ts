import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DemoApp, DEMO_QUESTION, freePort } from './app.js';
const dataDir=resolve('.contextline',`cli-${randomUUID()}`);
const app=new DemoApp({dataDir,databasePort:await freePort(),port:0});
function assert(condition: unknown,message: string): asserts condition {if(!condition)throw new Error(`Demo assertion failed: ${message}`);}
try {
  await app.start();await app.setWorker(false);
  const before=await app.query('acme-corp','alice',DEMO_QUESTION);
  assert(before.authorizedCount===1,'Alice can read the cached answer');
  await app.action('acme-corp','revoke-principal',{principal:'alice'});
  const after=await app.query('acme-corp','alice',DEMO_QUESTION);
  assert(after.authorizedCount===0,'Revoked Alice gets no revenue context');
  assert(!String(after.answer).includes('$12.4M'),'Restricted figures absent');
  const bob=await app.query('acme-corp','bob',DEMO_QUESTION);
  assert(!String(bob.answer).includes('$12.4M'),'Bob never receives revenue figures');
  const snapshot=await app.snapshot('acme-corp');
  assert((snapshot.storageCounts as {chunks:number}).chunks===14,'Principal revocation preserves shared storage');
  await app.action('acme-corp','delete-source',{});
  const stopped=await app.query('acme-corp','alice',DEMO_QUESTION);
  assert(!String(stopped.answer).includes('$12.4M'),'Enforcement protects while worker is paused');
  await app.setWorker(true);await app.worker.drain('acme-corp');
  const events=await app.registry.listEvents('acme-corp');
  const deletion=events.find(e=>e.eventType==='document_deleted');
  assert(deletion?.status==='completed',`All deletion jobs verified: ${JSON.stringify(deletion)} ${JSON.stringify(await app.registry.listJobs('acme-corp',deletion?.id))}`);
  const other=await app.query('other-corp','alice',DEMO_QUESTION);
  assert(String(other.answer).includes('€2.1M'),'Other tenant remains isolated');
  console.log(JSON.stringify({ok:true,before,after,deletion,otherTenantIsolated:true},null,2));
} finally {await app.stop();await rm(dataDir,{recursive:true,force:true});}
