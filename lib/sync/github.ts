import { createHash, createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

const positiveId = z.coerce.number().int().positive().safe();
const configuration = z.object({
  appId: positiveId, installationId: positiveId, repositoryId: positiveId,
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  repository: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/).refine((name) => !name.endsWith(".git") && name !== "." && name !== ".."),
  branch: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
    .refine((name) => !name.includes("..") && !name.includes("//") && !name.includes("@{") &&
      name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))),
  privateKey: z.string().min(1),
}).strict();
export type GitHubStateConfiguration = z.infer<typeof configuration>;
type Environment = Readonly<Record<string, string | undefined>>;

export function githubStateConfiguration(env: Environment): GitHubStateConfiguration {
  if (env.VERCEL_ENV === "preview") throw new Error("State sync is disabled in preview deployments.");
  if (env.STATE_SYNC_ENABLED !== "true") throw new Error("State sync is not enabled.");
  const parsed = configuration.safeParse({
    appId: env.STATE_GITHUB_APP_ID, installationId: env.STATE_GITHUB_INSTALLATION_ID,
    repositoryId: env.STATE_GITHUB_REPOSITORY_ID, owner: env.STATE_GITHUB_OWNER,
    repository: env.STATE_GITHUB_REPOSITORY, branch: env.STATE_GITHUB_BRANCH,
    privateKey: env.STATE_GITHUB_PRIVATE_KEY,
  });
  if (!parsed.success) throw new Error("State sync requires exact GitHub App, installation, private repository and branch configuration.");
  return parsed.data;
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const refSchema = z.object({ ref: z.string(), object: z.object({ type: z.literal("commit"), sha }) });
const commitSchema = z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })) });
const entrySchema = z.object({ path: z.string(), mode: z.string(), type: z.enum(["blob", "tree", "commit"]), sha });
const treeSchema = z.object({ sha, truncated: z.literal(false), tree: z.array(entrySchema) });
export type GitTreeEntry = z.infer<typeof entrySchema>;

export class StateGitHubError extends Error {
  constructor(readonly status: number | null, readonly retryable: boolean) {
    super(status === null ? "Private state repository request failed. Retry after checking connectivity." :
      `Private state repository request failed (HTTP ${status}). Check App permissions or retry later.`);
  }
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export interface PrivateStateRepository {
  head(): Promise<string>;
  commit(id: string): Promise<z.infer<typeof commitSchema>>;
  tree(id: string): Promise<GitTreeEntry[]>;
  blob(id: string, limit?: number): Promise<Uint8Array>;
  createBlob(bytes: Uint8Array): Promise<string>;
  createTree(base: string, entries: { path: string; sha: string | null }[]): Promise<string>;
  createCommit(parent: string, tree: string, message: string): Promise<string>;
  advance(id: string): Promise<void>;
}

/** fetch injection is for synthetic tests; all production request URLs remain fixed to api.github.com. */
export async function openPrivateStateRepository(
  input: GitHubStateConfiguration, fetcher: typeof fetch = fetch, now: () => number = Date.now,
): Promise<PrivateStateRepository> {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new Error("Invalid private state repository configuration.");
  const config = parsed.data;
  let key;
  try { key = createPrivateKey(config.privateKey); }
  catch { throw new Error("State sync requires a valid RSA GitHub App private key."); }
  if (key.asymmetricKeyType !== "rsa" || !(Number(key.asymmetricKeyDetails?.modulusLength) >= 2048)) {
    throw new Error("State sync requires a valid RSA GitHub App private key.");
  }
  const issued = Math.floor(now() / 1000);
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({
    iat: issued - 60, exp: issued + 540, iss: String(config.appId),
  })).toString("base64url")}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  const base = `/repos/${config.owner}/${config.repository}`;
  const branch = config.branch.split("/").map(encodeURIComponent).join("/");

  async function request<T>(token: string, path: string, schema: z.ZodType<T>, method = "GET", body?: unknown, limit?: number): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "Protein-Kitchen-State-Sync",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new StateGitHubError(null, true); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new StateGitHubError(response.status, response.status === 429 || response.status === 403 || response.status >= 500);
    }
    let value: unknown;
    try {
      if (limit === undefined) value = await response.json();
      else {
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > limit) throw new Error("Response exceeds limit.");
            chunks.push(chunk.value);
          }
          value = JSON.parse(Buffer.concat(chunks).toString());
        } finally { await reader.cancel(); reader.releaseLock(); }
      }
    }
    catch { throw new Error("Private state repository returned invalid JSON."); }
    const result = schema.safeParse(value);
    if (!result.success) throw new Error("Private state repository returned an invalid response.");
    return result.data;
  }

  const installation = await request(jwt, `/app/installations/${config.installationId}`, z.object({
    id: positiveId, app_id: positiveId, account: z.object({ login: z.string() }),
    suspended_at: z.null(), permissions: z.object({ contents: z.literal("write") }),
  }));
  if (installation.id !== config.installationId || installation.app_id !== config.appId ||
      installation.account.login.toLowerCase() !== config.owner.toLowerCase()) {
    throw new Error("GitHub App installation does not match the configured state repository owner.");
  }
  const access = await request(jwt, `/app/installations/${config.installationId}/access_tokens`, z.object({
    token: z.string().min(1), expires_at: z.string().datetime(),
    permissions: z.object({ contents: z.literal("write"), metadata: z.literal("read").optional() }).strict(),
    repositories: z.array(z.object({ id: positiveId, full_name: z.string(), private: z.literal(true) })).length(1),
  }), "POST", { repository_ids: [config.repositoryId], permissions: { contents: "write" } });
  const target = `${config.owner}/${config.repository}`.toLowerCase();
  if (access.repositories[0]!.id !== config.repositoryId || access.repositories[0]!.full_name.toLowerCase() !== target ||
      Date.parse(access.expires_at) <= now() + 60000) {
    throw new Error("GitHub App credential is not restricted to the expected private state repository or expires too soon.");
  }
  const repository = await request(access.token, base, z.object({
    id: positiveId, full_name: z.string(), private: z.literal(true), fork: z.literal(false),
    archived: z.literal(false), disabled: z.literal(false),
  }));
  if (repository.id !== config.repositoryId || repository.full_name.toLowerCase() !== target) {
    throw new Error("Private state repository identity does not match its pinned configuration.");
  }
  const call = <T>(path: string, schema: z.ZodType<T>, method?: string, body?: unknown, limit?: number) => {
    if (Date.parse(access.expires_at) <= now() + 30000) throw new Error("Private state repository credential expired. Start a fresh sync.");
    return request(access.token, `${base}${path}`, schema, method, body, limit);
  };
  const checkedSha = (id: string) => {
    if (!sha.safeParse(id).success) throw new Error("Invalid immutable Git object id.");
    return id;
  };
  const readRef = async (method = "GET", body?: unknown) => {
    const result = await call(`/git/${method === "GET" ? "ref" : "refs"}/heads/${branch}`, refSchema, method, body);
    if (result.ref !== `refs/heads/${config.branch}`) throw new Error("Private state repository returned the wrong branch.");
    return result.object.sha;
  };
  return {
    head: () => readRef(),
    async commit(id) {
      const result = await call(`/git/commits/${checkedSha(id)}`, commitSchema);
      if (result.sha !== id) throw new Error("Private state repository returned the wrong commit.");
      return result;
    },
    async tree(id) {
      const result = await call(`/git/trees/${checkedSha(id)}?recursive=1`, treeSchema);
      if (result.sha !== id || new Set(result.tree.map((entry) => entry.path)).size !== result.tree.length) {
        throw new Error("Private state repository returned an inconsistent tree.");
      }
      return result.tree;
    },
    async blob(id, limit = 65 * 1024 * 1024) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65 * 1024 * 1024) throw new Error("Invalid private blob size limit.");
      // GitHub wraps base64 at 60 columns; JSON escapes each line break.
      const encoded = Math.ceil(limit / 3) * 4;
      const result = await call(`/git/blobs/${checkedSha(id)}`, z.object({ sha, encoding: z.literal("base64"), content: z.string(), size: z.number().int().nonnegative().max(limit) }),
        "GET", undefined, encoded + Math.ceil(encoded / 60) * 2 + 1024 * 1024);
      const bytes = Buffer.from(result.content.replace(/\n/g, ""), "base64");
      if (result.sha !== id || result.size !== bytes.length || gitBlobSha(bytes) !== id) throw new Error("Private state repository returned corrupt blob bytes.");
      return bytes;
    },
    async createBlob(bytes) {
      const result = await call("/git/blobs", z.object({ sha }), "POST", { content: Buffer.from(bytes).toString("base64"), encoding: "base64" });
      if (result.sha !== gitBlobSha(bytes)) throw new Error("Private state repository did not confirm uploaded blob bytes.");
      return result.sha;
    },
    async createTree(baseTree, entries) {
      checkedSha(baseTree);
      if (!entries.length || new Set(entries.map((entry) => entry.path)).size !== entries.length ||
          entries.some((entry) => !/^protein-kitchen\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(entry.path) ||
            entry.path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
            (entry.sha !== null && !sha.safeParse(entry.sha).success))) {
        throw new Error("Invalid managed state tree changes.");
      }
      const result = await call("/git/trees", z.object({ sha }), "POST", {
        base_tree: baseTree, tree: entries.map((entry) => ({ ...entry, mode: "100644", type: "blob" })),
      });
      return result.sha;
    },
    async createCommit(parent, tree, message) {
      checkedSha(parent); checkedSha(tree);
      if (!message || message.length > 200 || /[\r\n]/.test(message)) throw new Error("Invalid state-sync commit message.");
      const result = await call("/git/commits", commitSchema, "POST", { parents: [parent], tree, message });
      if (result.tree.sha !== tree || result.parents.length !== 1 || result.parents[0]!.sha !== parent) {
        throw new Error("Private state repository returned an unexpected commit ancestry.");
      }
      return result.sha;
    },
    async advance(id) {
      checkedSha(id);
      if (await readRef("PATCH", { sha: id, force: false }) !== id) throw new Error("Private state repository did not confirm its branch update.");
    },
  };
}
