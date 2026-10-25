import { DeleteObjectCommand, GetBucketAclCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertBlobKey, type BlobStore } from "./types";

const PREFIX = "protein-kitchen/";
type S3Configuration = { bucket: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };
const missing = (error: unknown) => error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");

export function createS3Store(config: S3Configuration): BlobStore {
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  });
  const keyFor = (key: string) => { assertBlobKey(key); return `${PREFIX}${key}`; };
  let checked: Promise<void> | undefined;
  const ready = () => checked ??= (async () => {
    const acl = await client.send(new GetBucketAclCommand({ Bucket: config.bucket }));
    const ownerId = acl.Owner?.ID;
    if (!ownerId || !acl.Grants?.length || acl.Grants.some((grant) =>
      grant.Grantee?.Type !== "CanonicalUser" || grant.Grantee.ID !== ownerId || grant.Permission !== "FULL_CONTROL")) {
      throw new Error("Photo storage requires a private owner-only bucket.");
    }
  })().catch((error) => { checked = undefined; throw error; });
  return {
    async put(key, bytes, contentType) {
      const Key = keyFor(key); await ready();
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key, Body: bytes, ContentType: contentType, CacheControl: "private, no-store" }));
    },
    async get(key) {
      const Key = keyFor(key); await ready();
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key }));
        if (!response.Body) throw new Error("Private photo storage returned an object without a body.");
        return { bytes: await response.Body.transformToByteArray(), contentType: response.ContentType ?? "application/octet-stream" };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      const Key = keyFor(key); await ready();
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key }));
    },
    async exists(key) {
      const Key = keyFor(key); await ready();
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key }));
        return true;
      } catch (error) {
        if (missing(error)) {
          await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
          return false;
        }
        throw error;
      }
    },
    async list() {
      await ready();
      const keys: string[] = [];
      const seen = new Set<string>();
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: PREFIX, ContinuationToken: token }));
        for (const row of page.Contents ?? []) {
          if (!row.Key?.startsWith(PREFIX)) throw new Error("Private photo storage returned a key outside its namespace.");
          const key = row.Key.slice(PREFIX.length);
          assertBlobKey(key); keys.push(key);
        }
        if (!page.IsTruncated) break;
        token = page.NextContinuationToken;
        if (!token || seen.has(token)) throw new Error("Private photo storage returned invalid listing pagination.");
        seen.add(token);
      } while (true);
      return [...new Set(keys)].sort();
    },
  };
}
