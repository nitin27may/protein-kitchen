import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "../lib/blob/s3";

const objects = new Map<string, { bytes: Buffer; contentType: string }>();
const requests: { method: string; path: string; authorization?: string; cache?: string }[] = [];
let intercept: ((request: IncomingMessage, response: ServerResponse) => boolean) | undefined;
const privateAcl = '<Owner><ID>synthetic-owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>synthetic-owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList>';
let aclBody = privateAcl;
let aclError: string | undefined;
const xml = (response: ServerResponse, body: string, status = 200) => {
  response.writeHead(status, { "content-type": "application/xml" }); response.end(body);
};
const server = createServer(async (request, response) => {
  requests.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization, cache: request.headers["cache-control"] });
  const url = new URL(request.url!, "http://fixture.test");
  if (url.searchParams.has("acl")) {
    xml(response, aclError ? `<Error><Code>${aclError}</Code></Error>` : `<AccessControlPolicy>${aclBody}</AccessControlPolicy>`, aclError ? 404 : 200);
    return;
  }
  if (intercept?.(request, response)) return;
  if (request.method === "HEAD" && url.pathname === "/private-assets/") { response.end(); return; }
  if (url.searchParams.get("list-type") === "2") {
    const keys = [...objects.keys()].filter((key) => key.startsWith(url.searchParams.get("prefix")!)).sort();
    const offset = Number(url.searchParams.get("continuation-token") ?? 0);
    const page = keys.slice(offset, offset + 2);
    const more = offset + 2 < keys.length;
    xml(response, `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${offset + 2}</NextContinuationToken>` : ""}${page.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}</ListBucketResult>`);
    return;
  }
  const key = decodeURIComponent(url.pathname.slice("/private-assets/".length));
  if (request.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    objects.set(key, { bytes: Buffer.concat(chunks), contentType: String(request.headers["content-type"]) });
    response.end(); return;
  }
  if (request.method === "DELETE") { objects.delete(key); response.statusCode = 204; response.end(); return; }
  const object = objects.get(key);
  if (!object) { xml(response, "<Error><Code>NoSuchKey</Code><Message>Missing fixture object</Message></Error>", 404); return; }
  response.writeHead(200, { "content-type": object.contentType, "content-length": object.bytes.length });
  response.end(request.method === "HEAD" ? undefined : object.bytes);
});
let endpoint: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { objects.clear(); requests.length = 0; intercept = undefined; aclBody = privateAcl; aclError = undefined; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
});
const store = () => createS3Store({
  bucket: "private-assets", endpoint, region: "us-east-2", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret",
});
describe("private S3 BlobStore over actual loopback HTTP", () => {
  it("signs namespaced path-style requests, preserves bytes/type, paginates and deletes idempotently", async () => {
    const s = store();
    for (const key of ["photos/c/master.webp", "photos/a/master.webp", "photos/b/master.webp"]) await s.put(key, new Uint8Array([1, 2, 3]), "image/webp");
    expect([...objects.keys()].every((key) => key.startsWith("protein-kitchen/"))).toBe(true);
    expect(await s.get("photos/a/master.webp")).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp" });
    expect(await s.exists("photos/a/master.webp")).toBe(true);
    expect(await s.list()).toEqual(["photos/a/master.webp", "photos/b/master.webp", "photos/c/master.webp"]);
    expect(requests.filter((request) => request.path.includes("list-type=2"))).toHaveLength(2);
    expect(requests.every((request) => request.path.startsWith("/private-assets/") &&
      request.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=synthetic-access/") &&
      request.authorization.includes("/us-east-2/s3/aws4_request"))).toBe(true);
    expect(requests.filter((request) => request.method === "PUT").every((request) => request.cache === "private, no-store")).toBe(true);
    await s.delete("photos/a/master.webp"); await s.delete("photos/a/master.webp");
    expect(await s.get("photos/a/master.webp")).toBeNull();
    expect(await s.exists("photos/a/master.webp")).toBe(false);
  });
  it("returns empty listings and handles objects without explicit content type", async () => {
    const s = store();
    expect(await s.list()).toEqual([]);
    intercept = (_request, response) => { response.end(Buffer.from([4])); return true; };
    expect(await s.get("photos/a/master.webp")).toEqual({ bytes: new Uint8Array([4]), contentType: "application/octet-stream" });
  });
  it("does not treat access denial, unavailable buckets or service failures as missing objects", async () => {
    const s = store();
    for (const code of ["AccessDenied", "NoSuchBucket"]) {
      intercept = (_request, response) => { xml(response, `<Error><Code>${code}</Code></Error>`, 403); return true; };
      await expect(s.get("photos/a/master.webp")).rejects.toThrow();
      await expect(s.exists("photos/a/master.webp")).rejects.toThrow();
      await expect(s.put("photos/a/master.webp", new Uint8Array([1]), "image/webp")).rejects.toThrow();
      await expect(s.delete("photos/a/master.webp")).rejects.toThrow();
      await expect(s.list()).rejects.toThrow();
    }
  });
  it("does not hide a missing bucket behind an ambiguous HEAD-object 404", async () => {
    intercept = (_request, response) => { response.statusCode = 404; response.end(); return true; };
    await expect(store().exists("photos/a/master.webp")).rejects.toThrow();
    expect(requests).toHaveLength(3);
  });
  it("surfaces service failure after the bounded SDK retry count instead of returning missing data", async () => {
    intercept = (_request, response) => { xml(response, "<Error><Code>ServiceUnavailable</Code></Error>", 503); return true; };
    await expect(store().get("photos/a/master.webp")).rejects.toThrow();
    expect(requests.filter((request) => !request.path.includes("acl"))).toHaveLength(3);
  });
  it.each(["get", "exists"] as const)("does not confuse a failed privacy lookup with a missing object in %s", async (method) => {
    const s = store();
    aclError = "NoSuchKey";
    await expect(s[method]("photos/a/master.webp")).rejects.toThrow();
    expect(requests).toHaveLength(1);
    aclError = undefined;
    expect(await s[method]("photos/a/master.webp")).toBe(method === "get" ? null : false);
  });
  it.each([
    "<IsTruncated>true</IsTruncated>",
    "<IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken>",
    "<Contents><Key>outside/master.webp</Key></Contents>",
    "<Contents><Size>1</Size></Contents>",
    "<Contents><Key>protein-kitchen/../outside</Key></Contents>",
  ])("rejects corrupt object listings rather than skipping content: %s", async (body) => {
    intercept = (_request, response) => { xml(response, `<ListBucketResult>${body}</ListBucketResult>`); return true; };
    await expect(store().list()).rejects.toThrow();
  });
  it("rejects malformed keys before issuing HTTP requests", async () => {
    const s = store();
    await expect(s.put("../escape", new Uint8Array([1]), "image/webp")).rejects.toThrow();
    await expect(s.get("../escape")).rejects.toThrow();
    await expect(s.exists("../escape")).rejects.toThrow();
    await expect(s.delete("../escape")).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("refuses a provider result without an object body", async () => {
    vi.spyOn(S3Client.prototype, "send")
      .mockImplementationOnce(async () => ({ Owner: { ID: "owner" }, Grants: [{ Grantee: { Type: "CanonicalUser", ID: "owner" }, Permission: "FULL_CONTROL" }] }))
      .mockImplementationOnce(async () => ({}));
    await expect(store().get("photos/a/master.webp")).rejects.toThrow("without a body");
  });
  it.each([
    "", "<Owner><ID>owner</ID></Owner>",
    "<Owner><ID>owner</ID></Owner><AccessControlList><Grant><Permission>FULL_CONTROL</Permission></Grant></AccessControlList>",
    '<Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList>',
    '<Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>another</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList>',
    '<Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>READ</Permission></Grant></AccessControlList>',
  ])("refuses public, shared or malformed bucket ACLs and retries privacy validation after repair: %s", async (body) => {
    const s = store(); aclBody = body;
    await expect(s.put("photos/a/master.webp", new Uint8Array([1]), "image/webp")).rejects.toThrow("private owner-only bucket");
    expect(objects.size).toBe(0);
    aclBody = privateAcl;
    await s.put("photos/a/master.webp", new Uint8Array([1]), "image/webp");
    expect(objects.size).toBe(1);
  });
});
