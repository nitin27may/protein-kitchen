import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHubStateConfiguration, GitTreeEntry } from "../../lib/sync/github";

export const gitBlobSha = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const fixtureConfiguration: GitHubStateConfiguration = {
  appId: 123, installationId: 456, repositoryId: 789, owner: "synthetic-owner", repository: "private-state", branch: "state/synthetic",
  privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};
export const fixtureTime = Date.parse("2026-10-24T12:00:00.000Z");
export const base = "/repos/synthetic-owner/private-state";

export function githubFixture(now: () => number = () => fixtureTime) {
  const config = fixtureConfiguration;
  const requests: { path: string; method: string; body: Record<string, unknown> | undefined; authorization: string }[] = [];
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, GitTreeEntry[]>();
  const commits = new Map<string, { sha: string; tree: { sha: string }; parents: { sha: string }[] }>();
  let head: string;
  let endpoint: string;
  let intercept: ((request: IncomingMessage, response: ServerResponse, body: Record<string, unknown> | undefined) => boolean) | undefined;
  const json = (response: ServerResponse, data: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data));
  };
  function putBlob(bytes: Buffer) { const id = gitBlobSha(bytes); blobs.set(id, bytes); return id; }
  function putTree(entries: GitTreeEntry[]) { const id = sha(JSON.stringify(entries)); trees.set(id, entries); return id; }
  function putCommit(tree: string, parents: string[]) {
    const id = sha(JSON.stringify({ tree, parents })); commits.set(id, { sha: id, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) }); return id;
  }
  function edit(files: Record<string, string | null>) {
    const old = commits.get(head)!;
    const rows = [...trees.get(old.tree.sha)!];
    for (const [path, content] of Object.entries(files)) {
      const index = rows.findIndex((row) => row.path === path);
      if (index >= 0) rows.splice(index, 1);
      if (content !== null) rows.push({ path, mode: "100644", type: "blob", sha: putBlob(Buffer.from(content)) });
    }
    head = putCommit(putTree(rows), [head]);
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined;
    const path = request.url!;
    requests.push({ path, body, method: request.method!, authorization: request.headers.authorization ?? "" });
    if (intercept?.(request, response, body)) return;
    const jwtRequest = path.startsWith("/app/installations/");
    if (jwtRequest) {
      const token = request.headers.authorization?.slice(7).split(".");
      if (!token || token.length !== 3 || !verify("RSA-SHA256", Buffer.from(`${token[0]}.${token[1]}`), keys.publicKey, Buffer.from(token[2]!, "base64url"))) {
        json(response, {}, 401); return;
      }
    } else if (request.headers.authorization !== "Bearer synthetic-installation-token") { json(response, {}, 401); return; }
    if (path === `/app/installations/${config.installationId}`) {
      json(response, { id: config.installationId, app_id: config.appId, account: { login: config.owner }, suspended_at: null, permissions: { contents: "write" } }); return;
    }
    if (path === `/app/installations/${config.installationId}/access_tokens` && request.method === "POST") {
      json(response, { token: "synthetic-installation-token", expires_at: new Date(now() + 3600000).toISOString(),
        permissions: { contents: "write" }, repositories: [{ id: config.repositoryId, full_name: `${config.owner}/${config.repository}`, private: true }] }, 201); return;
    }
    if (path === base) {
      json(response, { id: config.repositoryId, full_name: `${config.owner}/${config.repository}`, private: true, fork: false, archived: false, disabled: false }); return;
    }
    if (path === `${base}/git/ref/heads/${config.branch}`) {
      json(response, { ref: `refs/heads/${config.branch}`, object: { type: "commit", sha: head } }); return;
    }
    if (path === `${base}/git/refs/heads/${config.branch}` && request.method === "PATCH") {
      const next = commits.get(String(body?.sha));
      if (body?.force !== false || next?.parents[0]?.sha !== head) { json(response, {}, 422); return; }
      head = next.sha;
      json(response, { ref: `refs/heads/${config.branch}`, object: { type: "commit", sha: head } }); return;
    }
    if (path.startsWith(`${base}/git/commits/`)) { json(response, commits.get(path.split("/").at(-1)!)); return; }
    if (path.startsWith(`${base}/git/trees/`)) {
      const id = path.split("/").at(-1)!.split("?")[0]!;
      json(response, { sha: id, tree: trees.get(id), truncated: false }); return;
    }
    if (path.startsWith(`${base}/git/blobs/`)) {
      const id = path.split("/").at(-1)!; const bytes = blobs.get(id);
      if (!bytes) { json(response, {}, 404); return; }
      json(response, { sha: id, size: bytes.length, encoding: "base64", content: bytes.toString("base64") }); return;
    }
    if (path === `${base}/git/blobs` && request.method === "POST") {
      json(response, { sha: putBlob(Buffer.from(String(body?.content), "base64")) }, 201); return;
    }
    if (path === `${base}/git/trees` && request.method === "POST") {
      const rows = [...trees.get(String(body?.base_tree))!];
      for (const entry of body!.tree as { path: string; sha: string | null; mode: string; type: "blob" }[]) {
        const index = rows.findIndex((row) => row.path === entry.path);
        if (index >= 0) rows.splice(index, 1);
        if (entry.sha !== null) rows.push({ ...entry, sha: entry.sha });
      }
      json(response, { sha: putTree(rows) }, 201); return;
    }
    if (path === `${base}/git/commits` && request.method === "POST") {
      const id = putCommit(String(body!.tree), body!.parents as string[]); json(response, commits.get(id), 201); return;
    }
    json(response, {}, 404);
  });
  return {
    requests, blobs, trees, commits, json, edit, putBlob, putTree, putCommit,
    get head() { return head; },
    get endpoint() { return endpoint; },
    set head(id: string) { head = id; },
    set intercept(value: typeof intercept) { intercept = value; },
    reset() {
      requests.length = 0; blobs.clear(); trees.clear(); commits.clear(); intercept = undefined;
      head = putCommit(putTree([{ path: "README.md", sha: putBlob(Buffer.from("Unmanaged synthetic README")), mode: "100644", type: "blob" }]), []);
    },
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close() {
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
    fetch: ((url, options) => {
      const target = new URL(String(url));
      if (target.origin !== "https://api.github.com") throw new Error("Fixture refused a non-GitHub request.");
      return fetch(`${endpoint}${target.pathname}${target.search}`, options);
    }) satisfies typeof fetch,
  };
}
