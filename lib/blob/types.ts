/**
 * Where photo bytes live. The database stores only keys, never bytes or URLs, so moving from a local folder to a
 * Neon bucket changes the store behind this interface and nothing else.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Null when the key is not stored. */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Every stored key, for the orphan check and backups. */
  list(): Promise<string[]>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** Keys are lower-case path-like names. Anything else (dots segments, absolute paths, backslashes) is refused. */
export function assertBlobKey(key: string): void {
  if (key.length > 200 || !KEY_PATTERN.test(key) || key.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`invalid blob key: ${JSON.stringify(key)}`);
  }
}
