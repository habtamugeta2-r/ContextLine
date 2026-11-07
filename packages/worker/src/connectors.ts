import type { Pool } from 'pg';
import { parseStorageRef } from '@contextline/core';
import type { ArtifactType, LifecycleAction } from '@contextline/core';

export interface ConnectorContext { tenantId: string; artifactType?: ArtifactType | undefined }
export interface StorageConnector {
  readonly type: string;
  delete(storageRef: string, context: ConnectorContext): Promise<void>;
  invalidate(storageRef: string, context: ConnectorContext): Promise<void>;
  verify(storageRef: string, context: ConnectorContext, expected: 'deleted' | 'invalidated'): Promise<boolean>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
}
export class ConnectorError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ConnectorError'; }
}
export interface TableConfig { table: string; idColumn?: string; tenantColumn?: string; statusColumn?: string; schema?: string }
interface ResolvedTable { table: string; idColumn: string; tenantColumn: string; statusColumn: string | undefined; schema: string }
const sqlName = (value: string): boolean => /^[a-z][a-z0-9_]{0,62}$/.test(value);

/** Table names come only from operator configuration; values are always parameterized. */
export class PostgresTableConnector implements StorageConnector {
  readonly type: string = 'postgres-table';
  private readonly tables: Map<string, ResolvedTable>;
  constructor(private readonly pool: Pool, tables: Record<string, TableConfig>) {
    this.tables = new Map(Object.entries(tables).map(([key, value]) => {
      const resolved: ResolvedTable = { table:value.table,idColumn:value.idColumn ?? 'id',tenantColumn:value.tenantColumn ?? 'tenant_id',statusColumn:value.statusColumn,schema:value.schema ?? 'public' };
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) || Object.values(resolved).some(v => v !== undefined && !sqlName(v))) throw new ConnectorError('INVALID_TABLE_CONFIGURATION');
      return [key,resolved];
    }));
    if (!this.tables.size) throw new ConnectorError('INVALID_TABLE_CONFIGURATION');
  }
  /** Accepts canonical `connector:target:record` and legacy `target/record`. */
  protected target(ref: string): { table: ResolvedTable; id: string } {
    let parsed;
    try { parsed = parseStorageRef(ref); } catch { throw new ConnectorError('INVALID_STORAGE_REFERENCE'); }
    const canonical = parsed.connector !== null && this.kinds.includes(parsed.connector);
    const key = canonical ? parsed.target : parsed.connector === null ? parsed.target : null;
    const id = canonical ? parsed.recordId : parsed.connector === null && parsed.target !== null ? parsed.recordId : ref;
    if (!key || !id) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    const table = this.tables.get(key);
    if (!table) throw new ConnectorError('UNKNOWN_TABLE');
    return { table,id };
  }
  protected get kinds(): string[] { return ['postgres','postgres-table']; }
  /** Memory carries synthesized knowledge: flag it for a human instead of marking stale. */
  protected invalidStatus(context: ConnectorContext): string { return context.artifactType === 'memory' ? 'pending_review' : 'stale'; }
  private qualified(table: ResolvedTable): string { return `"${table.schema}"."${table.table}"`; }
  async delete(ref: string, context: ConnectorContext): Promise<void> {
    const { table,id } = this.target(ref);
    await this.pool.query(`DELETE FROM ${this.qualified(table)} WHERE "${table.idColumn}"=$1 AND "${table.tenantColumn}"=$2`,[id,context.tenantId]);
  }
  async invalidate(ref: string, context: ConnectorContext): Promise<void> {
    const { table,id } = this.target(ref);
    if (!table.statusColumn) throw new ConnectorError('INVALIDATION_NOT_SUPPORTED');
    await this.pool.query(`UPDATE ${this.qualified(table)} SET "${table.statusColumn}"=$3 WHERE "${table.idColumn}"=$1 AND "${table.tenantColumn}"=$2`,[id,context.tenantId,this.invalidStatus(context)]);
  }
  async verify(ref: string, context: ConnectorContext, expected: 'deleted' | 'invalidated'): Promise<boolean> {
    const { table,id } = this.target(ref);
    const columns = expected === 'invalidated' && table.statusColumn ? `"${table.statusColumn}"` : '1';
    const result = await this.pool.query(`SELECT ${columns} FROM ${this.qualified(table)} WHERE "${table.idColumn}"=$1 AND "${table.tenantColumn}"=$2`,[id,context.tenantId]);
    if (!result.rowCount) return true;
    return expected === 'invalidated' && !!table.statusColumn && ['stale','pending_review'].includes(result.rows[0][table.statusColumn]);
  }
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      for (const table of this.tables.values()) await this.pool.query(`SELECT 1 FROM ${this.qualified(table)} LIMIT 0`);
      return { healthy:true,latencyMs:performance.now()-start };
    } catch { return { healthy:false,latencyMs:performance.now()-start }; }
  }
}
export class PgVectorConnector extends PostgresTableConnector {
  override readonly type = 'pgvector';
  private readonly hasStatusColumn: boolean;
  constructor(pool: Pool, table: TableConfig) { super(pool,{ pgvector:table }); this.hasStatusColumn = !!table.statusColumn; }
  protected override get kinds(): string[] { return ['pgvector']; }
  // Bare row IDs remain valid; `pgvector:target:record` is the canonical form.
  protected override target(ref: string): { table: ResolvedTable; id: string } {
    let parsed;
    try { parsed = parseStorageRef(ref); } catch { throw new ConnectorError('INVALID_STORAGE_REFERENCE'); }
    if (parsed.connector === 'pgvector') {
      if (!parsed.recordId) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
      return super.target(parsed.target ? `pgvector:${parsed.target}:${parsed.recordId}` : `pgvector/${parsed.recordId}`);
    }
    if (parsed.connector !== null) return super.target(`pgvector/${ref}`);
    if (!ref || ref.includes('/')) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    return super.target(`pgvector/${ref}`);
  }
  /** Blueprint A Part 4: without a status column, invalidation falls back to deletion. */
  override async invalidate(ref: string, context: ConnectorContext): Promise<void> {
    if (!this.hasStatusColumn) return this.delete(ref,context);
    return super.invalidate(ref,context);
  }
  override async verify(ref: string, context: ConnectorContext, expected: 'deleted' | 'invalidated'): Promise<boolean> {
    if (!this.hasStatusColumn) return super.verify(ref,context,'deleted');
    return super.verify(ref,context,expected);
  }
}

export interface RedisLike {
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  ping(): Promise<string>;
}
export const REDIS_INVALIDATION_TOMBSTONE = '{"contextline":{"invalidated":true,"version":1}}';
const INVALIDATE_SCRIPT = "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('SET', KEYS[1], ARGV[1], 'KEEPTTL') else return 0 end";
export class RedisConnector implements StorageConnector {
  readonly type = 'redis';
  private readonly requireTenantPrefix: boolean;
  private readonly invalidationMode: 'delete' | 'tombstone';
  constructor(private readonly client: RedisLike, options: { requireTenantPrefix?: boolean; invalidationMode?: 'delete' | 'tombstone' } = {}) {
    this.requireTenantPrefix = options.requireTenantPrefix ?? true;
    this.invalidationMode = options.invalidationMode ?? 'delete';
    if (!['delete','tombstone'].includes(this.invalidationMode)) throw new ConnectorError('INVALID_CONNECTOR_CONFIGURATION');
  }
  private key(ref: string, context: ConnectorContext): string {
    // Canonical `redis:target:key` and legacy tenant-prefixed keys are both accepted.
    let key = ref;
    if (ref.startsWith('redis:')) {
      const rest = ref.slice(6), split = rest.indexOf(':');
      key = split > 0 ? rest.slice(split+1) : rest;
    }
    if (!key || key.length > 1024 || /[\u0000-\u001f]/.test(key)) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    if (this.requireTenantPrefix && (!context.tenantId || !key.startsWith(`${context.tenantId}:`))) throw new ConnectorError('TENANT_PREFIX_REQUIRED');
    return key;
  }
  async delete(ref: string, context: ConnectorContext): Promise<void> { await this.client.del(this.key(ref,context)); }
  /** Blueprint A: Redis has no soft invalidation. Tombstones are an explicit opt-in. */
  async invalidate(ref: string, context: ConnectorContext): Promise<void> {
    const key = this.key(ref,context);
    if (this.invalidationMode === 'delete') { await this.client.del(key); return; }
    await this.client.eval(INVALIDATE_SCRIPT,1,key,REDIS_INVALIDATION_TOMBSTONE);
  }
  async verify(ref: string, context: ConnectorContext, expected: 'deleted' | 'invalidated'): Promise<boolean> {
    const value = await this.client.get(this.key(ref,context));
    return value === null || (expected === 'invalidated' && this.invalidationMode === 'tombstone' && value === REDIS_INVALIDATION_TOMBSTONE);
  }
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try { return { healthy:await this.client.ping() === 'PONG',latencyMs:performance.now()-start }; }
    catch { return { healthy:false,latencyMs:performance.now()-start }; }
  }
}
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation,new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new ConnectorError('CONNECTOR_TIMEOUT')),timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export function connectorAction(action: LifecycleAction): 'deleted' | 'invalidated' { return action === 'delete' ? 'deleted' : 'invalidated'; }
