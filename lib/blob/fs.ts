import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "./types";
import { assertBlobKey } from "./types";

const TYPE_BY_EXT: Record<string, string> = { ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json" };

/** Stores blobs as files under `root`. A write goes to a temp file first, then renames, so a crash never leaves a half file. */
export function createFsStore(root: string): BlobStore {
  const resolve = (key: string): string => {
    assertBlobKey(key);
    const file = path.resolve(root, key);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error(`blob key escapes the store: ${key}`);
    return file;
  };
  const notFound = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

  async function walk(dir: string, prefix: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (notFound(e)) return [];
      throw e;
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.endsWith(".tmp")) continue;
      if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), `${prefix}${e.name}/`)));
      else out.push(`${prefix}${e.name}`);
    }
    return out;
  }

  return {
    async put(key, bytes) {
      const file = resolve(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file);
    },
    async get(key) {
      try {
        const bytes = await fs.readFile(resolve(key));
        return { bytes, contentType: TYPE_BY_EXT[path.extname(key)] ?? "application/octet-stream" };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async delete(key) {
      try {
        await fs.unlink(resolve(key));
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    async exists(key) {
      try {
        await fs.access(resolve(key));
        return true;
      } catch (e) {
        if (notFound(e)) return false;
        throw e;
      }
    },
    async list() {
      return (await walk(path.resolve(root), "")).sort();
    },
  };
}
