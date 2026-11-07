import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { postgresFixture } from '../tests/postgres-fixture.js';
const f=await postgresFixture();
const percentile=(values:number[],p:number)=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]!;
try {
  const tenant='benchmark',roots=[{id:'bench-a',version:1},{id:'bench-b',version:1},{id:'bench-c',version:1}];
  for(const s of roots)await f.ctx.ensureSource(tenant,s);
  for(let batch=0;batch<10;batch++)await f.ctx.registerDerivation({tenantId:tenant,sources:roots,artifacts:Array.from({length:100},(_,i)=>({id:`bench-${batch*100+i}`,type:'embedding' as const,connectorId:'bench',storageRef:`bench-${batch*100+i}`}))});
  const candidates=Array.from({length:20},(_,i)=>({artifactId:`bench-${i}`}));
  const authorize=async(req:{sources:{id:string}[]})=>Object.fromEntries(req.sources.map(s=>[s.id,true]));
  for(let i=0;i<20;i++){const run=await f.ctx.beginRun(tenant,'bench');await f.ctx.filterAuthorized({run,candidates,authorize});}
  const samples:number[]=[];
  for(let i=0;i<100;i++){const run=await f.ctx.beginRun(tenant,'bench');const start=performance.now();const result=await f.ctx.filterAuthorized({run,candidates,authorize});if(result.length!==20)throw new Error('Benchmark authorization failed');samples.push(performance.now()-start);}
  console.log(JSON.stringify({date:new Date().toISOString(),node:process.version,postgresql:f.version,cpu:cpus()[0]?.model,cpuCount:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),artifacts:1000,rootsPerArtifact:3,candidatesPerRequest:20,iterations:100,warmup:20,includes:['dependency lookup','synthetic authorization callback','durable audit writes'],excludes:['vector search','network authorization service','LLM inference'],p50Ms:Number(percentile(samples,.5).toFixed(2)),p95Ms:Number(percentile(samples,.95).toFixed(2)),maxMs:Number(Math.max(...samples).toFixed(2)),warning:'Local synthetic microbenchmark, not a production latency or scale claim.'},null,2));
} finally {await f.cleanup();}
