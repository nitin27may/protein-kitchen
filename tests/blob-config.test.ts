import { afterEach, describe, expect, it, vi } from "vitest";
import { blobConfiguration, photoWritesEnabled } from "../lib/blob/config";
import { getBlobStore, setBlobStore } from "../lib/blob";
import { createMemoryStore } from "../lib/blob/memory";

const env = {
  BLOB_STORE: "neon", BLOB_BUCKET: "private-assets", DATABASE_ENV: "development",
  NEON_DEVELOPMENT_BRANCH_ID: "br-synthetic-dev", NEON_PRODUCTION_BRANCH_ID: "br-synthetic-prod",
  AWS_ENDPOINT_URL_S3: "https://br-synthetic-dev.storage.c-6.us-east-2.aws.neon.tech",
  AWS_REGION: "us-east-2", AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "synthetic-secret",
};
afterEach(() => { setBlobStore(null); vi.unstubAllEnvs(); });
describe("explicit private cloud photo configuration", () => {
  it("keeps local defaults and explicit uploads directories without accessing storage", () => {
    expect(blobConfiguration({})).toMatchObject({ kind: "filesystem", readOnly: false, root: expect.stringMatching(/uploads$/) });
    expect(blobConfiguration({ BLOB_STORE: "filesystem", UPLOADS_DIR: "/synthetic/uploads" })).toMatchObject({ root: "/synthetic/uploads" });
    expect(photoWritesEnabled({})).toBe(true);
    expect(photoWritesEnabled({ VERCEL_ENV: "preview" })).toBe(false);
  });
  it.each([
    { VERCEL: "1" }, { VERCEL_ENV: "production", BLOB_STORE: "filesystem" }, { BLOB_STORE: "typo" },
  ])("refuses hosted filesystem fallback and unknown store %s", (input) => {
    expect(() => blobConfiguration(input)).toThrow("BLOB_STORE=neon");
  });
  it("binds cloud storage to the deployment branch and makes previews read-only", () => {
    expect(blobConfiguration(env)).toMatchObject({ kind: "neon", readOnly: false, endpoint: env.AWS_ENDPOINT_URL_S3 });
    expect(blobConfiguration({ ...env, VERCEL_ENV: "preview" })).toMatchObject({ readOnly: true });
    expect(blobConfiguration({ ...env, DATABASE_ENV: "production", AWS_ENDPOINT_URL_S3: "https://br-synthetic-prod.storage.c-2.us-east-2.aws.neon.tech/" }))
      .toMatchObject({ endpoint: "https://br-synthetic-prod.storage.c-2.us-east-2.aws.neon.tech" });
  });
  it.each(["BLOB_BUCKET", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])("requires %s without a credential-chain fallback", (key) => {
    expect(() => blobConfiguration({ ...env, [key]: "" })).toThrow("requires bucket");
  });
  it.each([
    { BLOB_BUCKET: "../outside" }, { AWS_REGION: "unsupported" }, { DATABASE_ENV: "" }, { DATABASE_ENV: undefined },
    { NEON_DEVELOPMENT_BRANCH_ID: "" }, { NEON_DEVELOPMENT_BRANCH_ID: "bad_branch" },
    { AWS_ENDPOINT_URL_S3: "invalid-url" }, { AWS_ENDPOINT_URL_S3: "http://br-synthetic-dev.storage.c-6.us-east-2.aws.neon.tech" },
    { AWS_ENDPOINT_URL_S3: "https://user:secret@br-synthetic-dev.storage.c-6.us-east-2.aws.neon.tech" },
    { AWS_ENDPOINT_URL_S3: "https://:secret@br-synthetic-dev.storage.c-6.us-east-2.aws.neon.tech" },
    { AWS_ENDPOINT_URL_S3: `${env.AWS_ENDPOINT_URL_S3}:4433` }, { AWS_ENDPOINT_URL_S3: `${env.AWS_ENDPOINT_URL_S3}/outside` },
    { AWS_ENDPOINT_URL_S3: `${env.AWS_ENDPOINT_URL_S3}?secret=x` }, { AWS_ENDPOINT_URL_S3: `${env.AWS_ENDPOINT_URL_S3}#fragment` },
    { AWS_ENDPOINT_URL_S3: "https://br-synthetic-prod.storage.c-6.us-east-2.aws.neon.tech" },
    { AWS_ENDPOINT_URL_S3: `${env.AWS_ENDPOINT_URL_S3}.outside.test` },
    { AWS_ENDPOINT_URL_S3: "https://br-synthetic-dev.storage.c-wrong.us-east-2.aws.neon.tech" },
    { AWS_ENDPOINT_URL_S3: "https://br-synthetic-dev.storage.c-6.eu-central-1.aws.neon.tech" },
  ])("refuses incomplete/mismatched cloud configuration %s", (patch) => {
    expect(() => blobConfiguration({ ...env, ...patch })).toThrow();
  });
  it("initializes lazily, caches the store and retains the explicit test override", () => {
    vi.stubEnv("BLOB_STORE", "filesystem"); vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "");
    const local = getBlobStore();
    expect(getBlobStore()).toBe(local);
    setBlobStore(null);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(getBlobStore()).not.toBe(local);
    const override = createMemoryStore();
    setBlobStore(override); expect(getBlobStore()).toBe(override);
  });
  it("refuses preview writes and deletes even through the blob interface", async () => {
    for (const [key, value] of Object.entries({ ...env, VERCEL_ENV: "preview" })) vi.stubEnv(key, value);
    const store = getBlobStore();
    await expect(store.put("photos/synthetic/master.webp", new Uint8Array([1]), "image/webp")).rejects.toThrow("disabled in preview");
    await expect(store.delete("photos/synthetic/master.webp")).rejects.toThrow("disabled in preview");
  });
});
