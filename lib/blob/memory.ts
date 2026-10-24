import type { BlobStore } from "./types";
import { assertBlobKey } from "./types";

/** In-memory store for tests. */
export function createMemoryStore(): BlobStore & { size(): number } {
  const map = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key, bytes, contentType) {
      assertBlobKey(key);
      map.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key) {
      assertBlobKey(key);
      const v = map.get(key);
      return v ? { bytes: Uint8Array.from(v.bytes), contentType: v.contentType } : null;
    },
    async delete(key) {
      assertBlobKey(key);
      map.delete(key);
    },
    async exists(key) {
      assertBlobKey(key);
      return map.has(key);
    },
    async list() {
      return [...map.keys()].sort();
    },
    size: () => map.size,
  };
}
