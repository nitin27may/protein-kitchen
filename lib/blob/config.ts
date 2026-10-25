import path from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
export type BlobConfiguration = { kind: "filesystem"; root: string; readOnly: boolean } | {
  kind: "neon"; bucket: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; readOnly: boolean;
};
const regions = ["us-east-2", "us-east-1", "eu-central-1", "ap-southeast-1"];

export function photoWritesEnabled(env: Environment = process.env): boolean {
  return env.VERCEL_ENV !== "preview";
}

export function blobConfiguration(env: Environment): BlobConfiguration {
  const hosted = env.VERCEL === "1" || !!env.VERCEL_ENV;
  const kind = env.BLOB_STORE ?? (hosted ? "" : "filesystem");
  const readOnly = !photoWritesEnabled(env);
  if (kind === "filesystem" && !hosted) return { kind, root: env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads"), readOnly };
  if (kind !== "neon") throw new Error("Configure BLOB_STORE=neon for private cloud photos. Filesystem uploads are not supported on Vercel.");
  const { BLOB_BUCKET: bucket, AWS_ENDPOINT_URL_S3: endpoint, AWS_REGION: region, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!bucket || !endpoint || !region || !accessKeyId || !secretAccessKey) throw new Error("Private cloud photo storage requires bucket, endpoint, region and explicit branch credentials.");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !regions.includes(region)) throw new Error("Private cloud photo bucket or region is invalid.");
  if (!["development", "test", "preview", "production"].includes(env.DATABASE_ENV ?? "")) throw new Error("Cloud photos require an explicit DATABASE_ENV.");
  const branch = env.DATABASE_ENV === "production" ? env.NEON_PRODUCTION_BRANCH_ID : env.NEON_DEVELOPMENT_BRANCH_ID;
  if (!branch || !/^br-[a-z0-9-]+$/.test(branch)) throw new Error("Cloud photos require the deployment's explicit Neon branch id.");
  const url = new URL(endpoint);
  const prefix = `${branch}.storage.c-`;
  const suffix = `.${region}.aws.neon.tech`;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
      !url.hostname.startsWith(prefix) || !url.hostname.endsWith(suffix) ||
      !/^\d+$/.test(url.hostname.slice(prefix.length, -suffix.length))) {
    throw new Error("Private photo endpoint must match the deployment's Neon branch and region.");
  }
  return { kind, bucket, endpoint: url.origin, region, accessKeyId, secretAccessKey, readOnly };
}
