import path from "node:path";
import { createFsStore } from "./fs";
import type { BlobStore } from "./types";

export type { BlobStore } from "./types";

let current: BlobStore | null = null;

/** The app's photo store: the `uploads/` folder (or `UPLOADS_DIR`) until the Neon bucket replaces it. */
export function getBlobStore(): BlobStore {
  current ??= createFsStore(process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads"));
  return current;
}

/** Tests swap the store; pass null to go back to the default. */
export function setBlobStore(store: BlobStore | null): void {
  current = store;
}
