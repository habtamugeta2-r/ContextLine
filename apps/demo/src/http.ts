import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextLineError } from '@contextline/core';
import { DEMO_QUESTION, TENANTS } from './app.js';
import type { DemoApp } from './app.js';

const publicRoot=fileURLToPath(new URL('./public/',import.meta.url));
const mime: Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
let mutations: Promise<void>=Promise.resolve();
function sendJson(res: ServerResponse,status: number,data: unknown): void {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req: IncomingMessage): Promise<Record<string,unknown>> {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new ContextLineError('INVALID_REQUEST','Expected application/json');
  let size=0;const chunks: Buffer[]=[];
  for await (const chunk of req){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=buffer.length;if(size>32768)throw new ContextLineError('REQUEST_TOO_LARGE','Request exceeds 32 KiB');chunks.push(buffer);}
  let value: unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ContextLineError('INVALID_REQUEST','Invalid JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ContextLineError('INVALID_REQUEST','Expected a JSON object');
  return value as Record<string,unknown>;
}
function tenantOf(value: unknown): string {if(typeof value!=='string'||!(TENANTS as readonly string[]).includes(value))throw new ContextLineError('INVALID_TENANT','Choose a configured demo tenant');return value;}
export async function handleRequest(app: DemoApp,req: IncomingMessage,res: ServerResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
  try {
    const host=req.headers.host ?? 'localhost';const url=new URL(req.url ?? '/',`http://${host}`);
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')) {
      const html=await readFile(resolve(publicRoot,'index.html'));res.writeHead(200,{'Content-Type':mime['.html']!,'Cache-Control':'no-cache'});res.end(html);return;
    }
    if(req.method==='GET'&&/^\/assets\/[a-z0-9._-]+$/.test(url.pathname)) {
      const path=resolve(publicRoot,url.pathname.slice(1));if(!path.startsWith(resolve(publicRoot)+sep))throw new ContextLineError('NOT_FOUND','Not found');
      const data=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)] ?? 'application/octet-stream','Cache-Control':'no-cache'});res.end(data);return;
    }
    if(req.method==='GET'&&/^\/docs\/[a-zA-Z0-9-]+\.md$/.test(url.pathname)) {
      const docsRoot=fileURLToPath(new URL('../../../docs/',import.meta.url));
      const path=resolve(docsRoot,url.pathname.slice('/docs/'.length));
      if(!path.startsWith(resolve(docsRoot)+sep))throw new ContextLineError('NOT_FOUND','Not found');
      const data=await readFile(path);res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Cache-Control':'no-cache'});res.end(data);return;
    }
    if(url.pathname==='/api/health'&&req.method==='GET'){await app.registry.healthCheck();sendJson(res,200,{ok:true,synthetic:true,workerEnabled:app.workerEnabled});return;}
    if(url.pathname==='/api/snapshot'&&req.method==='GET'){sendJson(res,200,await app.snapshot(tenantOf(url.searchParams.get('tenant') ?? 'acme-corp')));return;}
    if(url.pathname==='/api/metrics'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});res.end(await app.worker.metrics());return;}
    if(!['POST','GET'].includes(req.method ?? '')){sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});return;}
    if(req.method!=='POST'||!['/api/query','/api/action'].includes(url.pathname)){sendJson(res,404,{error:'NOT_FOUND'});return;}
    // This is an unauthenticated synthetic demo, not a production authorization boundary.
    // Reject browser cross-site mutations; do not add permissive CORS.
    const origin=req.headers.origin;
    if(origin&&new URL(origin).host!==host){sendJson(res,403,{error:'ORIGIN_REJECTED'});return;}
    if(req.headers['sec-fetch-site']==='cross-site'){sendJson(res,403,{error:'ORIGIN_REJECTED'});return;}
    const input=await body(req);const tenant=tenantOf(input.tenant ?? 'acme-corp');
    if(url.pathname==='/api/query') {
      const principal=input.principal==='bob'?'bob':'alice';const question=typeof input.question==='string'?input.question:DEMO_QUESTION;
      if(question.length>500)throw new ContextLineError('INVALID_REQUEST','Question must be at most 500 characters');
      sendJson(res,200,await app.query(tenant,principal,question,input.useCache!==false));return;
    }
    const action=typeof input.action==='string'?input.action:'';
    const allowed=['reset','toggle-worker','toggle-outage','process-queue','retry-event','acknowledge-review','grant-principal','revoke-principal','delete-source','erase-source','restrict-source','reactivate-source','update-source'];
    if(!allowed.includes(action))throw new ContextLineError('INVALID_ACTION','Unknown demo action');
    const result=await new Promise<Record<string,unknown>>((resolveResult,reject) => {
      mutations=mutations.then(async()=>{try{resolveResult(await app.action(tenant,action,input));}catch(error){reject(error);}});
    });
    sendJson(res,200,result);
  } catch(error) {
    if(error instanceof ContextLineError)sendJson(res,400,{error:error.code,message:error.message});
    else if(error instanceof Error&&['INVALID_SOURCE','INVALID_ACTION','INVALID_EVENT','INVALID_VERSION'].includes(error.message))sendJson(res,400,{error:error.message});
    else if((error as NodeJS.ErrnoException).code==='ENOENT')sendJson(res,404,{error:'NOT_FOUND'});
    else sendJson(res,503,{error:'SERVICE_UNAVAILABLE',message:'The demo database or connector is unavailable. Check the server logs and retry.'});
  }
}
