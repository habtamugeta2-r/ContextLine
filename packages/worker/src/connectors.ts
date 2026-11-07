import type { Pool } from 'pg';
import type { LifecycleAction } from '@contextline/core';

export interface ConnectorContext { tenantId: string }
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
  protected target(ref: string): { table: ResolvedTable; id: string } {
    const split = ref.indexOf('/');
    if (split < 1 || split === ref.length-1 || ref.length > 1024 || /[\u0000-\u001f]/.test(ref)) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    const key = ref.slice(0,split), id = ref.slice(split+1);
    const table = this.tables.get(key);
    if (!id || id.includes('/')) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    if (!table) throw new ConnectorError('UNKNOWN_TABLE');
    return { table,id };
  }
  private qualified(table: ResolvedTable): string { return `"${table.schema}"."${table.table}"`; }
  async delete(ref: string, context: ConnectorContext): Promise<void> {
    const { table,id } = this.target(ref);
    await this.pool.query(`DELETE FROM ${this.qualified(table)} WHERE "${table.idColumn}"=$1 AND "${table.tenantColumn}"=$2`,[id,context.tenantId]);
  }
  async invalidate(ref: string, context: ConnectorContext): Promise<void> {
    const { table,id } = this.target(ref);
    if (!table.statusColumn) throw new ConnectorError('INVALIDATION_NOT_SUPPORTED');
    await this.pool.query(`UPDATE ${this.qualified(table)} SET "${table.statusColumn}"='stale' WHERE "${table.idColumn}"=$1 AND "${table.tenantColumn}"=$2`,[id,context.tenantId]);
  }
  async verify(ref: string, context: ConnectorContext, expected: 'deleted' | 'invalidated'): Promise<boolean> {
    const { table,id } = this.target(ref);
    const columns = expected === 'invalidated' && table.statusColumn ? `"${table.statusColumn}"` : '1';
    const result = await this.pool.query(`SELECT ${columns} FROM ${this.qualified(table)} WHERE "${table.idColumn}"=$1 AND "${table.tenantColumn}"=$2`,[id,context.tenantId]);
    if (!result.rowCount) return true;
    return expected === 'invalidated' && !!table.statusColumn && result.rows[0][table.statusColumn] === 'stale';
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
  constructor(pool: Pool, table: Omit<TableConfig,'statusColumn'>) { super(pool,{ pgvector:table }); }
  // PgVector refs are bare row IDs, not user-supplied SQL or table names.
  protected override target(ref: string): { table: ResolvedTable; id: string } {
    if (!ref || ref.includes('/') || /[\u0000-\u001f]/.test(ref)) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    return super.target(`pgvector/${ref}`);
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
  constructor(private readonly client: RedisLike, options: { requireTenantPrefix?: boolean } = {}) { this.requireTenantPrefix = options.requireTenantPrefix ?? true; }
  private key(ref: string, context: ConnectorContext): string {
    if (!ref || ref.length > 1024 || /[\u0000-\u001f]/.test(ref)) throw new ConnectorError('INVALID_STORAGE_REFERENCE');
    if (this.requireTenantPrefix && (!context.tenantId || !ref.startsWith(`${context.tenantId}:`))) throw new ConnectorError('TENANT_PREFIX_REQUIRED');
    return ref;
  }
  async delete(ref: string, context: ConnectorContext): Promise<void> { await this.client.del(this.key(ref,context)); }
  async invalidate(ref: string, context: ConnectorContext): Promise<void> { await this.client.eval(INVALIDATE_SCRIPT,1,this.key(ref,context),REDIS_INVALIDATION_TOMBSTONE); }
  async verify(ref: string, context: ConnectorContext, expected: 'deleted' | 'invalidated'): Promise<boolean> {
    const value = await this.client.get(this.key(ref,context));
    return value === null || (expected === 'invalidated' && value === REDIS_INVALIDATION_TOMBSTONE);
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
