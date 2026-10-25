import type { DataSet } from "../data/load";
import { libraryVersion } from "../db/library-version";
import { buildAnonLibraryPayload, type AnonLibraryPayload } from "../plan/anon-library";

/** Library-only: reads /data, never the database, a session or a household. Safe to serve to anyone and to cache. */
const cache = new WeakMap<DataSet, { version: string; payload: AnonLibraryPayload; body: string }>();

export function anonLibrary(data: DataSet) {
  let entry = cache.get(data);
  if (!entry) {
    const version = libraryVersion(data);
    const payload = buildAnonLibraryPayload(data, version);
    entry = { version, payload, body: JSON.stringify(payload) };
    cache.set(data, entry);
  }
  return entry;
}

export const currentLibraryVersion = (data: DataSet): string => anonLibrary(data).version;
