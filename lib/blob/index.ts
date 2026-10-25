import { blobConfiguration } from "./config";
import { createFsStore } from "./fs";
import { createS3Store } from "./s3";
import type { BlobStore } from "./types";

export type { BlobStore } from "./types";

let current: BlobStore | null = null;

/** Lazy configuration keeps credentials and storage access out of imports/builds. */
export function getBlobStore(): BlobStore {
  if (!current) {
    const config = blobConfiguration(process.env);
    const store = config.kind === "filesystem" ? createFsStore(config.root) : createS3Store(config);
    current = config.readOnly ? {
      ...store,
      async put() { throw new Error("Photo changes are disabled in preview deployments."); },
      async delete() { throw new Error("Photo changes are disabled in preview deployments."); },
    } : store;
  }
  return current;
}

/** Tests swap the store; pass null to go back to the default. */
export function setBlobStore(store: BlobStore | null): void {
  current = store;
}
