import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorError, withTimeout } from './connectors.js';
import type { StorageConnector } from './connectors.js';
import type { Diagnostic, LifecycleJob, PostgresRegistry } from '@contextline/core';

export interface WorkerOptions {
  registry: PostgresRegistry;
  connectors: Record<string, StorageConnector>;
  tenants: string[];
  batchSize?: number;
  concurrency?: number;
  intervalMs?: number;
  leaseMs?: number;
  operationTimeoutMs?: number;
  maxAttempts?: number;
  retryDelaysMs?: number[];
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}
export class LifecycleWorker {
  private readonly options: Required<Omit<WorkerOptions,'onDiagnostic'>> & Pick<WorkerOptions,'onDiagnostic'>;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private cursor = 0;
  readonly counters = new Map<string,{ processed: number; failures: number; claimed: number }>();
  constructor(options: WorkerOptions) {
    if (!options.tenants.length || options.tenants.length > 100 || new Set(options.tenants).size !== options.tenants.length) throw new Error('Configure 1–100 unique worker tenants');
    this.options = { batchSize:20,concurrency:4,intervalMs:500,leaseMs:60000,operationTimeoutMs:10000,maxAttempts:6,retryDelaysMs:[1000,5000,30000,300000,1800000],...options };
    if (!Number.isInteger(this.options.batchSize) || this.options.batchSize < 1 || this.options.batchSize > 100 || !Number.isInteger(this.options.concurrency) || this.options.concurrency < 1 || this.options.concurrency > 20) throw new Error('Invalid worker batch/concurrency');
    if (this.options.leaseMs <= this.options.operationTimeoutMs*2+1000) throw new Error('Lease must exceed both connector timeouts plus database margin');
    if (!this.options.retryDelaysMs.length || this.options.retryDelaysMs.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid retry delays');
  }
  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = (async () => {
      while (!signal.aborted) {
        try {
          const count = await this.tick();
          if (!count && !signal.aborted) await delay(this.options.intervalMs,undefined,{ signal }).catch(() => undefined);
        } catch {
          this.options.onDiagnostic?.({ code:'WORKER_DATABASE_ERROR',operation:'tick',tenantId:'configured-tenants' });
          if (!signal.aborted) await delay(this.options.intervalMs,undefined,{ signal }).catch(() => undefined);
        }
      }
    })();
  }
  async stop(): Promise<void> { this.controller?.abort(); await this.running; this.running=null; }
  /** One bounded scheduling pass; applications may call this directly in tests. */
  async tick(): Promise<number> { return (await this.pass()).processed; }
  async pass(): Promise<{ processed: number; events: number; claimed: number }> {
    const tenants = this.options.tenants.map((_,i)=>this.options.tenants[(this.cursor+i)%this.options.tenants.length]!);
    const result = await this.passTenants(tenants);
    this.cursor = (this.cursor+1)%this.options.tenants.length;
    return result;
  }
  private async passTenants(tenants: string[]): Promise<{ processed: number; events: number; claimed: number }> {
    let processed = 0, events = 0, claimed = 0;
    for (const tenantId of tenants) {
      if (!this.counters.has(tenantId)) this.counters.set(tenantId,{ processed:0,failures:0,claimed:0 });
      if (await this.options.registry.materializeNextEvent(tenantId,this.options.maxAttempts)) events++;
      const jobs = await this.options.registry.claimJobs(tenantId,this.options.batchSize,this.options.leaseMs);
      claimed += jobs.length;
      this.counters.get(tenantId)!.claimed += jobs.length;
      for (let offset=0;offset<jobs.length;offset+=this.options.concurrency) {
        const results = await Promise.all(jobs.slice(offset,offset+this.options.concurrency).map(job => this.execute(job)));
        processed += results.filter(Boolean).length;
      }
    }
    return { processed, events, claimed };
  }
  async drain(tenantId: string, maxJobs = 1000): Promise<number> {
    if (!this.options.tenants.includes(tenantId)) throw new Error('Tenant is not configured for this worker');
    let count=0;
    for (let pass=0;count < maxJobs && pass < maxJobs+100;pass++) {
      const result = await this.passTenants([tenantId]);
      count += result.processed;
      if (!result.events && !result.claimed) break;
    }
    return count;
  }
  private async execute(job: LifecycleJob): Promise<boolean> {
    let result: 'completed' | 'pending_review' | 'retry' | 'failed' = 'completed';
    let errorCode: string | undefined;
    let verified = false;
    const counters = this.counters.get(job.tenantId)!;
    try {
      if (job.action === 'flag') result='pending_review';
      else {
        const connector = this.options.connectors[job.connectorId];
        if (!connector) throw new ConnectorError('CONNECTOR_NOT_CONFIGURED');
        const context = { tenantId:job.tenantId };
        if (job.action === 'delete') await withTimeout(connector.delete(job.storageRef,context),this.options.operationTimeoutMs);
        else await withTimeout(connector.invalidate(job.storageRef,context),this.options.operationTimeoutMs);
        verified = await withTimeout(connector.verify(job.storageRef,context,job.action === 'delete'?'deleted':'invalidated'),this.options.operationTimeoutMs);
        if (!verified) throw new ConnectorError('VERIFICATION_FAILED');
      }
    } catch (error) {
      errorCode = error instanceof ConnectorError ? error.code : 'CONNECTOR_ERROR';
      result = job.attempts >= job.maxAttempts ? 'failed' : 'retry';
      counters.failures++;
    }
    const delayMs = result === 'retry' ? this.options.retryDelaysMs[Math.min(job.attempts-1,this.options.retryDelaysMs.length-1)] : 0;
    const committed = await this.options.registry.finishJob(job,{ status:result,errorCode,verified,delayMs });
    if (committed && result === 'completed') counters.processed++;
    return committed;
  }
  async metrics(): Promise<string> {
    const samples: string[] = ['contextline_worker_up 1'];
    for (const tenant of this.options.tenants) {
      samples.push(...this.options.registry.metricsText(tenant,this.counters.get(tenant) ?? { processed:0,failures:0,claimed:0 }).split('\n').filter(line => line && !line.startsWith('#')));
      const stats = await this.options.registry.queueStats(tenant);
      const t = tenant.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n');
      samples.push(`contextline_queue_jobs{tenant="${t}"} ${stats.pending}`,`contextline_dead_letter_jobs{tenant="${t}"} ${stats.failed}`,`contextline_review_jobs{tenant="${t}"} ${stats.review}`);
    }
    const types = ['contextline_worker_up gauge','contextline_jobs_processed_total counter','contextline_job_failures_total counter','contextline_jobs_claimed_total counter','contextline_queue_jobs gauge','contextline_dead_letter_jobs gauge','contextline_review_jobs gauge'];
    return types.map(t=>`# TYPE ${t}`).join('\n')+'\n'+samples.join('\n')+'\n';
  }
}
