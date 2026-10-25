import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubStateConfiguration, openPrivateStateRepository, StateGitHubError } from "../lib/sync/github";
import { base, fixtureConfiguration as config, fixtureTime, githubFixture } from "./helpers/github-state";

const fixture = githubFixture();
beforeAll(() => fixture.start());
afterAll(() => fixture.close());
beforeEach(() => fixture.reset());
const open = () => openPrivateStateRepository(config, fixture.fetch, () => fixtureTime);
const env = {
  STATE_SYNC_ENABLED: "true", STATE_GITHUB_APP_ID: "123", STATE_GITHUB_INSTALLATION_ID: "456",
  STATE_GITHUB_REPOSITORY_ID: "789", STATE_GITHUB_OWNER: config.owner, STATE_GITHUB_REPOSITORY: config.repository,
  STATE_GITHUB_BRANCH: config.branch, STATE_GITHUB_PRIVATE_KEY: config.privateKey,
};
const id = "a".repeat(40);

describe("private state configuration and GitHub App admission", () => {
  it("requires explicit enablement, pins all target identifiers and refuses preview", () => {
    expect(githubStateConfiguration(env)).toEqual(config);
    expect(() => githubStateConfiguration({ ...env, VERCEL_ENV: "preview" })).toThrow("preview");
    expect(() => githubStateConfiguration({ ...env, STATE_SYNC_ENABLED: "false" })).toThrow("not enabled");
    expect(() => githubStateConfiguration({})).toThrow("not enabled");
  });

  it.each([
    { STATE_GITHUB_APP_ID: "" }, { STATE_GITHUB_INSTALLATION_ID: "0" }, { STATE_GITHUB_REPOSITORY_ID: "1.5" },
    { STATE_GITHUB_OWNER: "../bad" }, { STATE_GITHUB_REPOSITORY: "bad.git" }, { STATE_GITHUB_REPOSITORY: ".." },
    { STATE_GITHUB_REPOSITORY: "." }, { STATE_GITHUB_BRANCH: "a/../bad" }, { STATE_GITHUB_BRANCH: "a//bad" },
    { STATE_GITHUB_BRANCH: "a/.hidden" }, { STATE_GITHUB_BRANCH: "a/bad." }, { STATE_GITHUB_BRANCH: "a/bad.lock" },
    { STATE_GITHUB_BRANCH: "a/" }, { STATE_GITHUB_BRANCH: "" }, { STATE_GITHUB_BRANCH: "a@{bad" },
    { STATE_GITHUB_PRIVATE_KEY: "" },
  ])("refuses incomplete/unsafe target configuration without echoing values: %s", (patch) => {
    expect(() => githubStateConfiguration({ ...env, ...patch })).toThrow("exact GitHub App");
  });

  it("signs a real App JWT and requests only contents write on the single pinned repository", async () => {
    await open();
    expect(fixture.requests).toHaveLength(3);
    const jwt = fixture.requests[0]!.authorization.slice(7).split(".");
    expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString())).toEqual({
      iat: fixtureTime / 1000 - 60, exp: fixtureTime / 1000 + 540, iss: "123",
    });
    expect(fixture.requests[1]!.body).toEqual({ repository_ids: [789], permissions: { contents: "write" } });
    expect(fixture.requests[2]!.authorization).toBe("Bearer synthetic-installation-token");
  });

  it("rejects invalid direct configuration and malformed/non-RSA/weak keys before requests", async () => {
    await expect(openPrivateStateRepository({ ...config, appId: -1 }, fixture.fetch)).rejects.toThrow("Invalid private");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    for (const privateKey of ["SENSITIVE_INVALID_KEY", ec, weak]) {
      await expect(openPrivateStateRepository({ ...config, privateKey }, fixture.fetch)).rejects.toThrow("valid RSA");
    }
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    { id: 999 }, { app_id: 999 }, { account: { login: "another-owner" } }, { suspended_at: "2026-10-24T00:00:00Z" },
    { permissions: { contents: "read" } },
  ])("rejects mismatched/suspended/read-only installations before minting credentials: %s", async (patch) => {
    fixture.intercept = (request, response) => {
      if (request.url !== "/app/installations/456") return false;
      fixture.json(response, { id: 456, app_id: 123, account: { login: config.owner }, suspended_at: null, permissions: { contents: "write" }, ...patch }); return true;
    };
    await expect(open()).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([
    { expires_at: new Date(fixtureTime + 1000).toISOString() },
    { repositories: [{ id: 999, full_name: `${config.owner}/${config.repository}`, private: true }] },
    { repositories: [{ id: 789, full_name: `${config.owner}/other`, private: true }] },
    { repositories: [{ id: 789, full_name: `${config.owner}/${config.repository}`, private: false }] },
    { repositories: [] }, { repositories: [{ id: 789, full_name: "one", private: true }, { id: 790, full_name: "two", private: true }] },
    { permissions: { contents: "read" } }, { permissions: { contents: "write", issues: "write" } },
    { token: "" }, { expires_at: "invalid" },
  ])("rejects expired/broad/public/wrong token scopes before repository access: %s", async (patch) => {
    fixture.intercept = (request, response) => {
      if (!request.url!.endsWith("/access_tokens")) return false;
      fixture.json(response, { token: "synthetic-installation-token", expires_at: new Date(fixtureTime + 3600000).toISOString(),
        permissions: { contents: "write" }, repositories: [{ id: 789, full_name: `${config.owner}/${config.repository}`, private: true }], ...patch }); return true;
    };
    await expect(open()).rejects.toThrow();
    expect(fixture.requests).toHaveLength(2);
  });

  it.each([{ id: 999 }, { full_name: `${config.owner}/wrong` }, { private: false }, { fork: true }, { archived: true }, { disabled: true }])(
    "refuses unsafe repository metadata before content operations: %s", async (patch) => {
      fixture.intercept = (request, response) => {
        if (request.url !== base) return false;
        fixture.json(response, { id: 789, full_name: `${config.owner}/${config.repository}`, private: true, fork: false, archived: false, disabled: false, ...patch }); return true;
      };
      await expect(open()).rejects.toThrow();
      expect(fixture.requests).toHaveLength(3);
    },
  );

  it("allows GitHub's metadata read permission and case-insensitive target names", async () => {
    fixture.intercept = (request, response) => {
      if (!request.url!.endsWith("/access_tokens")) return false;
      fixture.json(response, { token: "synthetic-installation-token", expires_at: new Date(fixtureTime + 3600000).toISOString(),
        permissions: { contents: "write", metadata: "read" }, repositories: [{ id: 789, full_name: `${config.owner}/${config.repository}`.toUpperCase(), private: true }] }); return true;
    };
    await expect(open()).resolves.toBeDefined();
  });
});

describe("bounded private Git HTTP and immutable object verification", () => {
  it("accepts wrapped base64 at the encoded-response boundary and refuses one extra byte", async () => {
    const repository = await open(), bytes = Buffer.alloc(60, 65);
    const blob = fixture.putBlob(bytes), content = bytes.toString("base64").match(/.{1,60}/g)!.join("\n");
    const boundary = 80 + 4 + 1024 * 1024;
    for (const extra of [0, 1]) {
      const value = { sha: blob, size: bytes.length, encoding: "base64", content, padding: "" };
      value.padding = " ".repeat(boundary + extra - Buffer.byteLength(JSON.stringify(value)));
      const responseBody = JSON.stringify(value);
      expect(Buffer.byteLength(responseBody)).toBe(boundary + extra);
      fixture.intercept = (request, response) => {
        if (!request.url?.includes("/git/blobs/")) return false;
        response.writeHead(200, { "content-type": "application/json" }); response.end(responseBody);
        return true;
      };
      if (extra) await expect(repository.blob(blob, bytes.length)).rejects.toThrow("invalid JSON");
      else expect(await repository.blob(blob, bytes.length)).toEqual(bytes);
    }
  });
  it("rejects invalid blob limits before requests and bounds the streamed encoded response", async () => {
    const repository = await open();
    const before = fixture.requests.length;
    for (const limit of [0, -1, 1.5, Number.NaN, 65 * 1024 * 1024 + 1]) {
      await expect(repository.blob(id, limit)).rejects.toThrow("size limit");
    }
    expect(fixture.requests).toHaveLength(before);
    fixture.intercept = (request, response) => {
      if (!request.url?.includes("/git/blobs/")) return false;
      fixture.json(response, { sha: id, size: 1, encoding: "base64", content: "A".repeat(2 * 1024 * 1024) });
      return true;
    };
    await expect(repository.blob(id, 1)).rejects.toThrow("invalid JSON");
  });
  it.each([401, 403, 404, 409, 422, 429, 500, 503])("surfaces HTTP %s without response data or automatic write retries", async (status) => {
    fixture.intercept = (_request, response) => { fixture.json(response, { message: "SENSITIVE_UPSTREAM_CONTENT" }, status); return true; };
    const error = await open().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StateGitHubError);
    expect(error).toMatchObject({ status, retryable: status === 403 || status === 429 || status >= 500 });
    expect(String(error)).not.toContain("SENSITIVE");
    expect(fixture.requests).toHaveLength(1);
  });

  it("sanitizes network errors and disallows redirect following", async () => {
    fixture.intercept = (_request, response) => { response.writeHead(302, { location: "http://127.0.0.1:1/not-allowed" }); response.end(); return true; };
    await expect(open()).rejects.toMatchObject({ status: null, retryable: true });
    expect(fixture.requests).toHaveLength(1);
    await expect(openPrivateStateRepository(config, async () => { throw new Error("SENSITIVE_NETWORK_ERROR"); }, () => fixtureTime))
      .rejects.toThrow("checking connectivity");
  });

  it("rejects malformed JSON and malformed success responses", async () => {
    fixture.intercept = (_request, response) => { response.end("SENSITIVE_NOT_JSON"); return true; };
    await expect(open()).rejects.toThrow("invalid JSON");
    fixture.intercept = (_request, response) => { fixture.json(response, {}); return true; };
    await expect(open()).rejects.toThrow("invalid response");
  });

  it("refreshes credentials only by reopening and never uses an expired installation token", async () => {
    let time = fixtureTime;
    const repository = await openPrivateStateRepository(config, fixture.fetch, () => time);
    time += 3600000;
    await expect(repository.head()).rejects.toThrow("expired");
    expect(fixture.requests).toHaveLength(3);
  });

  it("reads actual commit/tree/blob bytes and verifies created blobs, commits and non-force updates", async () => {
    const repository = await open();
    const parent = await repository.head();
    const old = await repository.commit(parent);
    const rows = await repository.tree(old.tree.sha);
    expect(Buffer.from(await repository.blob(rows[0]!.sha)).toString()).toBe("Unmanaged synthetic README");
    const blob = await repository.createBlob(Buffer.from("Synthetic state"));
    const tree = await repository.createTree(old.tree.sha, [{ path: "protein-kitchen/manifest.json", sha: blob }]);
    const commit = await repository.createCommit(parent, tree, "Synthetic sync");
    await repository.advance(commit);
    expect(await repository.head()).toBe(commit);
    expect(fixture.requests.find((request) => request.method === "PATCH")!.body).toEqual({ sha: commit, force: false });
  });

  it("refuses invalid object ids, tree paths and commit messages before content HTTP", async () => {
    const repository = await open();
    await expect(repository.commit("bad")).rejects.toThrow("object id");
    await expect(repository.tree("bad")).rejects.toThrow("object id");
    await expect(repository.blob("bad")).rejects.toThrow("object id");
    await expect(repository.advance("bad")).rejects.toThrow("object id");
    await expect(repository.createCommit("bad", id, "message")).rejects.toThrow("object id");
    await expect(repository.createCommit(id, "bad", "message")).rejects.toThrow("object id");
    for (const message of ["", "bad\nmessage", "a".repeat(201)]) await expect(repository.createCommit(id, id, message)).rejects.toThrow("message");
    for (const entries of [[], [{ path: "unmanaged", sha: id }], [{ path: "protein-kitchen/../bad", sha: id }],
      [{ path: "protein-kitchen/.git/config", sha: id }], [{ path: "protein-kitchen/a//b", sha: id }],
      [{ path: "protein-kitchen/a", sha: "bad" }], [{ path: "protein-kitchen/a", sha: id }, { path: "protein-kitchen/a", sha: id }]]) {
      await expect(repository.createTree(id, entries)).rejects.toThrow("managed state");
    }
    await expect(repository.createTree("bad", [{ path: "protein-kitchen/a", sha: null }])).rejects.toThrow("object id");
    expect(fixture.requests).toHaveLength(3);
  });

  it.each(["ref", "commit", "tree", "duplicate-tree", "truncated", "blob-id", "blob-size", "blob-bytes", "upload", "commit-tree", "commit-parent", "commit-parents", "advance"])(
    "rejects malformed/wrong immutable acknowledgements: %s", async (kind) => {
      const repository = await open();
      const current = fixture.commits.get(fixture.head)!;
      const blob = fixture.putBlob(Buffer.from("Synthetic"));
      fixture.intercept = (request, response) => {
        const path = request.url!;
        if (kind === "ref" && path.includes("/git/ref/")) fixture.json(response, { ref: "refs/heads/wrong", object: { type: "commit", sha: id } });
        else if (kind === "commit" && path.includes("/git/commits/")) fixture.json(response, { ...current, sha: id });
        else if (["tree", "duplicate-tree", "truncated"].includes(kind) && path.includes("/git/trees/")) {
          const entry = { path: "a", sha: blob, type: "blob", mode: "100644" };
          fixture.json(response, { sha: kind === "tree" ? id : current.tree.sha, tree: kind === "duplicate-tree" ? [entry, entry] : [], truncated: kind === "truncated" });
        } else if (kind.startsWith("blob-") && path.includes("/git/blobs/")) fixture.json(response, {
          sha: kind === "blob-id" ? id : blob, size: kind === "blob-size" ? 99 : 9, encoding: "base64",
          content: Buffer.from(kind === "blob-bytes" ? "Incorrect" : "Synthetic").toString("base64"),
        });
        else if (kind === "upload" && path.endsWith("/git/blobs")) fixture.json(response, { sha: id });
        else if (kind.startsWith("commit-") && path.endsWith("/git/commits")) fixture.json(response, {
          sha: id, tree: { sha: kind === "commit-tree" ? "b".repeat(40) : current.tree.sha },
          parents: kind === "commit-parents" ? [] : [{ sha: kind === "commit-parent" ? id : fixture.head }],
        });
        else if (kind === "advance" && request.method === "PATCH") fixture.json(response, { ref: `refs/heads/${config.branch}`, object: { type: "commit", sha: id } });
        else return false;
        return true;
      };
      if (kind === "ref") await expect(repository.head()).rejects.toThrow("wrong branch");
      else if (kind === "commit") await expect(repository.commit(fixture.head)).rejects.toThrow("wrong commit");
      else if (["tree", "duplicate-tree", "truncated"].includes(kind)) await expect(repository.tree(current.tree.sha)).rejects.toThrow();
      else if (kind.startsWith("blob-")) await expect(repository.blob(blob)).rejects.toThrow("corrupt blob");
      else if (kind === "upload") await expect(repository.createBlob(Buffer.from("Synthetic"))).rejects.toThrow("confirm uploaded");
      else if (kind.startsWith("commit-")) await expect(repository.createCommit(fixture.head, current.tree.sha, "Synthetic")).rejects.toThrow("ancestry");
      else await expect(repository.advance(fixture.head)).rejects.toThrow("branch update");
    },
  );
});
