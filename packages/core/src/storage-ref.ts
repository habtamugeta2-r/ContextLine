import { ContextLineError } from './validation.js';

export interface ParsedStorageRef {
  /** Connector type when the canonical `connector:target:record` form is used. */
  connector: string | null;
  /** Logical allowlist target, or null for connector-specific bare identifiers. */
  target: string | null;
  recordId: string;
}
const CONNECTOR = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Blueprint A Part 4: one fixed shape, `connector:target:record`, parsed in one place.
 * The record ID may itself contain colons (Redis keys are tenant-prefixed), so only the
 * first two separators are structural. Legacy `target/record` and bare-ID forms are
 * still accepted so existing registrations keep working; they are documented aliases.
 */
export function parseStorageRef(ref: string): ParsedStorageRef {
  if (typeof ref !== 'string' || !ref || ref.length > 1024 || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new ContextLineError('INVALID_STORAGE_REFERENCE', 'Storage reference must be 1–1024 characters without control characters');
  }
  const first = ref.indexOf(':');
  if (first > 0 && CONNECTOR.test(ref.slice(0, first))) {
    const rest = ref.slice(first + 1);
    const second = rest.indexOf(':');
    if (second > 0 && second < rest.length - 1) {
      return { connector: ref.slice(0, first), target: rest.slice(0, second), recordId: rest.slice(second + 1) };
    }
    // `connector:record` (no logical target) is used by single-table connectors.
    if (rest) return { connector: ref.slice(0, first), target: null, recordId: rest };
    throw new ContextLineError('INVALID_STORAGE_REFERENCE', 'Storage reference is missing a record identifier');
  }
  const split = ref.indexOf('/');
  if (split > 0 && split < ref.length - 1) {
    const recordId = ref.slice(split + 1);
    if (recordId.includes('/')) throw new ContextLineError('INVALID_STORAGE_REFERENCE', 'Storage reference record identifier must not contain "/"');
    return { connector: null, target: ref.slice(0, split), recordId };
  }
  return { connector: null, target: null, recordId: ref };
}
