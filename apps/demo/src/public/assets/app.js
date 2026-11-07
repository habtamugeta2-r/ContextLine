const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
let state = null;
let busy = false;
let toastTimer;
let snapshotLoading = false;
const typeClass = {embedding:'blue',cache:'purple',summary:'green',memory:'amber',other:'neutral'};
const statusClass = (status) => ['active','completed','allowed'].includes(status) ? 'green' : ['deleted','failed','revoked','denied'].includes(status) ? 'red' : ['stale','pending_review','partial','pending','retry','processing'].includes(status) ? 'amber' : 'neutral';
const badge = (status) => `<span class="badge ${statusClass(status)}">${esc(status.replaceAll('_',' '))}</span>`;
const time = (value) => new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const tenant = () => $('tenant').value;
function toast(message, error=false) { clearTimeout(toastTimer); $('toast').textContent=message; $('toast').className=`toast visible${error?' error':''}`; toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4500); }
async function api(path, data) {
  const response=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant:tenant(),...data})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message || result.error || 'Request failed');
  return result;
}
async function refresh() {
  if(snapshotLoading)return;
  snapshotLoading=true;
  const requestedTenant=tenant();
  try { const result=await api(`/api/snapshot?tenant=${encodeURIComponent(requestedTenant)}`);if(requestedTenant!==tenant())return;state=result;render();$('connection-status').textContent='Registry connected'; }
  catch { $('connection-status').textContent='Connection unavailable'; }
  finally {snapshotLoading=false;}
}
function render() {
  if(!state)return;
  const artifacts=state.artifacts;
  $('workspace-name').textContent=tenant()==='acme-corp'?'Acme Corporation':'Other Corporation';
  $('nav-count').textContent=artifacts.length;
  $('metric-artifacts').textContent=artifacts.length;
  $('metric-active').textContent=artifacts.filter(a=>a.status==='active').length;
  $('metric-denied').textContent=state.decisions.filter(d=>!d.allowed).length;
  $('metric-queue').textContent=state.queue.pending;
  $('metric-queue-note').textContent=`${state.queue.failed} dead-letter · ${state.queue.review} awaiting review`;
  $('metric-artifacts-note').textContent=tenant()==='acme-corp'?'18 initial derivatives · four demo stores':'Separate tenant, identical source identifiers';
  $('worker-state').textContent=state.workerEnabled?'running':'paused';
  $('worker-state').className=`badge ${state.workerEnabled?'green':'amber'}`;
  $('toggle-worker').textContent=state.workerEnabled?'Pause worker':'Resume worker';
  $('toggle-outage').textContent=state.outage?'Restore storage':'Simulate storage outage';
  $('toggle-outage').classList.toggle('danger-light',state.outage);
  const source=state.sources.find(s=>s.id==='doc:q3-revenue-projections'&&s.isCurrent);
  $('source-status').textContent=source?`${source.status} · v${source.version}`:'unknown';
  $('source-status').className=`badge ${statusClass(source?.status)}`;
  $('access-list').innerHTML=['alice','bob'].map(p=>{const allowed=state.grants.some(g=>g.principal===p&&g.source_id==='doc:q3-revenue-projections');return `<span><i class="access-dot ${allowed?'':'denied'}"></i><b>${p[0].toUpperCase()+p.slice(1)}</b> ${allowed?'can read':'denied'}</span>`;}).join('');
  const counts=state.storageCounts;
  $('storage-strip').innerHTML=[['Retrieval chunks',counts.chunks],['Cached answers',counts.cache],['Summaries',counts.summaries],['Agent facts',counts.memories]].map(([name,n])=>`<span><strong>${n}</strong> ${name}</span>`).join('');
  renderRegistry();renderEvents();renderAudit();
}
function renderRegistry() {
  if(!state)return;
  const search=$('registry-search').value.toLowerCase(),type=$('registry-type').value;
  const rows=state.artifacts.filter(a=>(!type||a.type===type)&&`${a.id} ${a.storageRef} ${a.sources.map(s=>s.id).join(' ')}`.toLowerCase().includes(search));
  $('registry-body').innerHTML=rows.length?rows.map(a=>`<tr><td><strong>${esc(a.id)} <span class="root-chip">v${a.version}</span></strong><code>${esc(a.storageRef)}</code></td><td><span class="badge ${typeClass[a.type]||'neutral'}">${esc(a.type)}</span></td><td>${a.sources.map(s=>`<span class="root-chip" title="${esc(s.id)}">${esc(s.id.replace('doc:',''))} · v${s.version}</span>`).join('')}</td><td>${badge(a.status)}</td></tr>`).join(''):'<tr><td colspan="4" class="empty-state">No artifacts match this filter.</td></tr>';
  $('registry-count').textContent=`Showing ${rows.length} of ${state.artifacts.length} registered artifacts`;
}
function renderEvents() {
  const openIds=new Set([...document.querySelectorAll('.event[open]')].map(e=>e.dataset.id));
  $('events-list').innerHTML=state.events.length?state.events.map(e=>{
    const jobs=state.jobs.filter(j=>j.eventId===e.id);
    const note=e.details.propagation==='authorization_only'?'Principal-specific permission change. Shared data is preserved; the authoritative ACL and retrieval checks enforce the change.':e.eventType==='source_restricted'?'Source-wide restriction blocks retrieval. Memory derivatives are flagged for review rather than silently erased.':e.eventType==='document_updated'?'Previous-version artifacts are blocked and invalidated. New content must be ingested and registered separately.':'Source lifecycle status is enforced immediately. Worker actions are verified before completion.';
    return `<details class="event" data-id="${esc(e.id)}" ${openIds.has(e.id)?'open':''}><summary><span class="icon-box ${e.status==='completed'?'teal':'purple'}">${icon('cycle')}</span><span class="event-title"><strong>${esc(e.eventType.replaceAll('_',' '))}</strong><small>${esc(e.sourceId)} · ${time(e.createdAt)}${e.affectedPrincipals.length?' · '+esc(e.affectedPrincipals.join(', ')):''}</small></span><span class="event-progress">${e.processedArtifacts}/${e.affectedArtifacts} processed</span>${badge(e.status)}<span class="event-chevron">⌄</span></summary><div class="event-body"><p class="event-note">${note}</p>${jobs.length?jobs.map(j=>`<div class="job-row"><code>${esc(j.artifactId)}</code><span>${esc(j.action)}</span>${badge(j.status)}<span>attempt ${j.attempts}/${j.maxAttempts}</span><span class="${j.verifiedAt?'verified':''}">${j.verifiedAt?'✓ verified '+time(j.verifiedAt):j.status==='pending_review'?'human review required':'not verified'}</span>${j.lastErrorCode?`<code>${esc(j.lastErrorCode)}</code>`:''}</div>`).join(''):'<p class="fine-print">No storage jobs are required for this event.</p>'}<div class="event-actions"><button class="button small subtle" data-retry="${esc(e.id)}">Retry dead-letter jobs</button> ${jobs.filter(j=>j.status==='pending_review').map(j=>`<button class="button small subtle" data-review="${esc(j.id)}">Acknowledge review · keep blocked</button>`).join(' ')} <code class="fine-print">${esc(e.id)}</code></div></div></details>`;
  }).join(''):`<div class="empty-state"><span class="icon-box teal">${icon('cycle')}</span><strong>No lifecycle changes yet</strong><p>Revoke a principal, restrict a source, or publish a new version. Every event and connector outcome will appear here.</p></div>`;
}
function renderAudit() {
  $('audit-body').innerHTML=state.decisions.length?state.decisions.slice(0,60).map(d=>`<tr><td>${time(d.createdAt)}</td><td><strong>${esc(d.principal)}</strong></td><td><strong>${esc(d.artifactId)}</strong><code>run ${esc(d.runId.slice(0,8))} · v${d.artifactVersion}</code></td><td>${badge(d.outcome)}</td><td><span class="root-chip">${esc(d.reason.replaceAll('_',' '))}</span></td></tr>`).join(''):'<tr><td colspan="5" class="empty-state">No access decisions yet. Ask the assistant to create an audited retrieval run.</td></tr>';
}
async function ask(event) {
  event?.preventDefault();if(busy)return;busy=true;
  const button=$('query-form').querySelector('button');button.disabled=true;
  const requestedTenant=tenant();
  try {
    const result=await api('/api/query',{principal:$('principal').value,question:$('question').value,useCache:$('use-cache').checked});
    if(requestedTenant!==tenant())return;
    const blocked=result.authorizedCount===0;
    $('answer').className=`answer${blocked?' blocked':''}`;
    $('answer').innerHTML=`<span class="icon-box ${blocked?'purple':'teal'}">${icon('shield')}</span><div><strong>${blocked?'No authorized context returned':result.mode==='cache'?'Cached answer · sources revalidated':'Authorized context · ready for generation'}</strong><p>${esc(result.answer)}</p><div class="answer-meta"><span>${result.authorizedCount} authorized artifact${result.authorizedCount===1?'':'s'}</span><span>${esc(result.mode)}</span><code>run ${esc(result.runId.slice(0,8))}</code></div><p class="fine-print">${esc(result.disclaimer)}</p></div>`;
  }catch(error){toast(error.message,true);}finally{busy=false;button.disabled=false;await refresh();}
}
async function action(name,extra={}) {
  if(busy)return;busy=true;
  document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try {const result=await api('/api/action',{action:name,principal:$('principal').value,sourceId:'doc:q3-revenue-projections',...extra});toast(result.note || (name==='reset'?'Demo reset. All synthetic artifacts and permissions restored.':name==='toggle-worker'?`Worker ${result.workerEnabled?'resumed':'paused'}. Retrieval enforcement remains active.`:name==='toggle-outage'?`Storage ${result.outage?'outage enabled':'restored'}.`:name==='process-queue'?`${result.processed} jobs processed.`:name==='retry-event'?`${result.retried} dead-letter jobs requeued.`:'Lifecycle event recorded.'));}
  catch(error){toast(error.message,true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);await refresh();}
}
$('query-form').addEventListener('submit',ask);
$('tenant').addEventListener('change',()=>{state=null;$('answer').className='answer empty';$('answer').innerHTML=`<span class="icon-box teal">${icon('shield')}</span><div><strong>Switched tenant boundary</strong><p>Identical source IDs are isolated. Ask a question in this tenant to create a new audit trail.</p></div>`;void refresh();});
$('registry-search').addEventListener('input',renderRegistry);$('registry-type').addEventListener('change',renderRegistry);
document.querySelectorAll('[data-question]').forEach(b=>b.addEventListener('click',()=>{$('question').value=b.dataset.question;void ask();}));
for(const name of ['grant-principal','revoke-principal','restrict-source','update-source','toggle-worker','toggle-outage','process-queue','reactivate-source'])$(name).addEventListener('click',()=>void action(name));
for(const name of ['delete-source','erase-source','reset-demo'])$(name).addEventListener('click',()=>{const actionName=name==='reset-demo'?'reset':name;if(confirm(name==='reset-demo'?'Reset this tenant’s synthetic data and audit history?':`Apply ${name.replaceAll('-',' ')} to the synthetic revenue source in this tenant?`))void action(actionName);});
$('events-list').addEventListener('click',event=>{const retry=event.target.closest('[data-retry]');if(retry)void action('retry-event',{eventId:retry.dataset.retry});const review=event.target.closest('[data-review]');if(review)void action('acknowledge-review',{jobId:review.dataset.review});});
const navLinks=[...document.querySelectorAll('.nav-item')];
navLinks.forEach(link=>link.addEventListener('click',()=>{navLinks.forEach(l=>l.classList.toggle('active',l===link));document.querySelector('.breadcrumb strong').textContent=link.textContent.trim().replace(/\d+$/,'');}));
void refresh();
setInterval(()=>{if(!document.hidden&&!busy)void refresh();},2200);
