/**
 * Stand-ins for the customer's own systems. ContextLine never owns these:
 * the vector store, the cache, and the authorization service all stay yours.
 */
export interface SearchHit { artifactId: string; artifactVersion: number; text: string; score: number }
export interface VectorStore {
  search(query: string, limit: number): Promise<SearchHit[]>;
  write(id: string, text: string): Promise<void>;
}
export interface AnswerCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
export interface PermissionService {
  /** Returns one explicit boolean per requested source. Anything else is treated as a denial. */
  check(request: { tenantId: string; principal: string; sources: { id: string; version: number }[] }): Promise<Record<string, boolean>>;
}
export const notImplemented = (name: string): never => { throw new Error(`Wire this example to your own ${name}`); };
