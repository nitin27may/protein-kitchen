import { z } from "zod";

/**
 * Write-capable Neon control-plane client for CI snapshot and rehearsal branches.
 *
 * Deliberately separate from the GET-only `neonHttpControlPlane`: nothing that only verifies a target can create or
 * delete a branch. Fixed https origin, no redirects, timeouts, and no response body, header, URL or credential in any
 * error. The API key is read from `NEON_API_KEY` only by `neonAdminFromEnv`.
 */

export type NeonAdminCode =
  | "NEON_ADMIN_CONFIG" | "NEON_ADMIN_UNREACHABLE" | "NEON_ADMIN_HTTP" | "NEON_ADMIN_INVALID" | "NEON_ADMIN_LIMIT"
  | "NEON_ADMIN_NOT_FOUND" | "NEON_ADMIN_OPERATION_FAILED" | "NEON_ADMIN_TIMEOUT" | "NEON_ADMIN_REFUSED_TARGET"
  | "NEON_ADMIN_PRUNE_FAILED";

export class NeonAdminError extends Error {
  override name = "NeonAdminError";
  constructor(readonly code: NeonAdminCode, message: string) {
    super(`${code}: ${message}`);
  }
}

const ORIGIN = "https://console.neon.tech/api/v2";
const PROJECT_ID = /^[a-z0-9-]+$/;
const BRANCH_ID = /^br-[a-z0-9-]+$/;
const OPERATION_ID = /^[A-Za-z0-9-]+$/;
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,63}$/;

const branchSchema = z.object({
  id: z.string(), project_id: z.string(), name: z.string().min(1), current_state: z.string(),
  created_at: z.string().optional(), parent_id: z.string().nullish(), expires_at: z.string().nullish(),
  default: z.boolean().optional(), primary: z.boolean().optional(), protected: z.boolean().optional(),
});
const operationSchema = z.object({ id: z.string(), status: z.string() });
const createdSchema = z.object({
  branch: branchSchema,
  operations: z.array(operationSchema).default([]),
  endpoints: z.array(z.object({ id: z.string(), host: z.string() })).optional(),
});

export type NeonAdminBranch = z.infer<typeof branchSchema>;

export interface CreateBranchInput {
  parent_id: string;
  name: string;
  /** ISO 8601 timestamp; Neon deletes the branch after it. */
  expires_at: string;
  /** Omit for a storage-only snapshot branch with no compute. */
  endpoints?: readonly { type: "read_write" | "read_only" }[];
}

export interface ConnectionUriInput { branch_id: string; database_name: string; role_name: string; pooled: boolean }

export interface NeonAdminOptions {
  request?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  /** Total time to wait for operations and branch readiness. */
  maxWaitMs?: number;
  requestTimeoutMs?: number;
}

export interface PruneResult { kept: number; deleted: number }

export interface NeonAdmin {
  createBranch(project: string, input: CreateBranchInput): Promise<NeonAdminBranch>;
  getBranch(project: string, branchId: string): Promise<NeonAdminBranch>;
  listBranches(project: string): Promise<NeonAdminBranch[]>;
  /** Deletes only a branch whose name starts with one of `allowedPrefixes`; never a default, primary or protected branch. */
  deleteBranch(project: string, branchId: string, allowedPrefixes: readonly string[]): Promise<void>;
  /** Fresh connection URI (contains a credential: callers must mask it and never print it). */
  connectionUri(project: string, input: ConnectionUriInput): Promise<string>;
  /** Keeps the newest `keep` branches whose name matches `namePattern`; deletes the rest. */
  prune(project: string, options: { prefix: string; namePattern: RegExp; keep: number }): Promise<PruneResult>;
}

/** Reads the key from the environment inside this function only; it is never logged or returned. */
export function neonAdminFromEnv(env: Readonly<Record<string, string | undefined>>, options: NeonAdminOptions = {}): NeonAdmin {
  const apiKey = env.NEON_API_KEY;
  if (!apiKey) throw new NeonAdminError("NEON_ADMIN_CONFIG", "NEON_API_KEY is required.");
  return neonAdmin(apiKey, options);
}

const LIMIT_PATTERN = /limit|exceed|quota|maximum|too many/i;

export function neonAdmin(apiKey: string, options: NeonAdminOptions = {}): NeonAdmin {
  const request = options.request ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  const project = (id: string) => {
    if (!PROJECT_ID.test(id)) throw new NeonAdminError("NEON_ADMIN_CONFIG", "The Neon project id is malformed.");
    return id;
  };
  const branchId = (id: string) => {
    if (!BRANCH_ID.test(id)) throw new NeonAdminError("NEON_ADMIN_CONFIG", "A Neon branch id is malformed.");
    return id;
  };

  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await request(`${ORIGIN}${path}`, {
        method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(requestTimeoutMs),
        headers: body === undefined
          ? { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
          : { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new NeonAdminError("NEON_ADMIN_UNREACHABLE", "The Neon control plane could not be reached.");
    }
    if (!response.ok) {
      if (response.status === 404) throw new NeonAdminError("NEON_ADMIN_NOT_FOUND", "The Neon resource was not found.");
      if (method === "POST" && (response.status === 402 || response.status === 422 || response.status === 409 || response.status === 406)) {
        // The body is read only to recognise a plan limit; none of it is ever copied into the message.
        const text = await response.text().catch(() => "");
        if (response.status === 402 || LIMIT_PATTERN.test(text)) {
          throw new NeonAdminError(
            "NEON_ADMIN_LIMIT",
            `Neon refused to create the branch because a plan limit was reached (HTTP ${response.status}). ` +
            "Free-tier branch or storage limit: delete unused branches in the Neon console, then rerun. Nothing was created.",
          );
        }
      }
      throw new NeonAdminError("NEON_ADMIN_HTTP", `The Neon control plane answered HTTP ${response.status}.`);
    }
    let json: unknown;
    try { json = await response.json(); } catch {
      throw new NeonAdminError("NEON_ADMIN_INVALID", "The Neon control plane returned invalid JSON.");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new NeonAdminError("NEON_ADMIN_INVALID", "The Neon control plane returned incomplete metadata.");
    return parsed.data;
  }

  const FAILED = new Set(["failed", "error", "cancelled", "cancelling", "skipped"]);

  async function waitForOperations(projectId: string, operations: readonly { id: string; status: string }[], deadline: number): Promise<void> {
    for (const initial of operations) {
      if (!OPERATION_ID.test(initial.id)) throw new NeonAdminError("NEON_ADMIN_INVALID", "The Neon control plane returned a malformed operation id.");
      let status = initial.status;
      while (status !== "finished") {
        if (FAILED.has(status)) throw new NeonAdminError("NEON_ADMIN_OPERATION_FAILED", "A Neon operation did not complete.");
        if (now() >= deadline) throw new NeonAdminError("NEON_ADMIN_TIMEOUT", "Timed out waiting for a Neon operation to finish.");
        await sleep(pollIntervalMs);
        status = (await call("GET", `/projects/${projectId}/operations/${initial.id}`, z.object({ operation: operationSchema }))).operation.status;
      }
    }
  }

  async function waitForReady(projectId: string, id: string, deadline: number): Promise<NeonAdminBranch> {
    for (;;) {
      const branch = (await call("GET", `/projects/${projectId}/branches/${id}`, z.object({ branch: branchSchema }))).branch;
      if (branch.current_state === "ready") return branch;
      if (now() >= deadline) throw new NeonAdminError("NEON_ADMIN_TIMEOUT", "Timed out waiting for the Neon branch to become ready.");
      await sleep(pollIntervalMs);
    }
  }

  const admin: NeonAdmin = {
    async createBranch(projectId, input) {
      const p = project(projectId);
      branchId(input.parent_id);
      if (!IDENTIFIER.test(input.name) || Number.isNaN(Date.parse(input.expires_at))) {
        throw new NeonAdminError("NEON_ADMIN_CONFIG", "The branch name or expiry is malformed.");
      }
      const created = await call("POST", `/projects/${p}/branches`, createdSchema, {
        branch: { parent_id: input.parent_id, name: input.name, expires_at: input.expires_at },
        ...(input.endpoints?.length ? { endpoints: input.endpoints.map((e) => ({ type: e.type })) } : {}),
      });
      if (created.branch.project_id !== p || created.branch.name !== input.name) {
        throw new NeonAdminError("NEON_ADMIN_INVALID", "The created branch does not match the request.");
      }
      const deadline = now() + maxWaitMs;
      await waitForOperations(p, created.operations, deadline);
      return waitForReady(p, created.branch.id, deadline);
    },

    async getBranch(projectId, id) {
      return (await call("GET", `/projects/${project(projectId)}/branches/${branchId(id)}`, z.object({ branch: branchSchema }))).branch;
    },

    async listBranches(projectId) {
      return (await call("GET", `/projects/${project(projectId)}/branches`, z.object({ branches: z.array(branchSchema) }))).branches;
    },

    async deleteBranch(projectId, id, allowedPrefixes) {
      const p = project(projectId);
      const branch = await admin.getBranch(p, id);
      if (branch.id !== id || branch.project_id !== p || !allowedPrefixes.some((prefix) => branch.name.startsWith(prefix)) ||
          branch.default || branch.primary || branch.protected) {
        throw new NeonAdminError("NEON_ADMIN_REFUSED_TARGET", "Only a disposable rehearsal or pre-deploy branch can be deleted.");
      }
      const result = await call("DELETE", `/projects/${p}/branches/${id}`, z.object({ operations: z.array(operationSchema).default([]) }));
      await waitForOperations(p, result.operations, now() + maxWaitMs);
    },

    async connectionUri(projectId, input) {
      const query = new URLSearchParams({
        branch_id: branchId(input.branch_id), database_name: input.database_name, role_name: input.role_name,
        pooled: String(input.pooled),
      });
      if (!IDENTIFIER.test(input.database_name) || !IDENTIFIER.test(input.role_name)) {
        throw new NeonAdminError("NEON_ADMIN_CONFIG", "The database or role name is malformed.");
      }
      return (await call("GET", `/projects/${project(projectId)}/connection_uri?${query}`, z.object({ uri: z.string().min(1) }))).uri;
    },

    async prune(projectId, { prefix, namePattern, keep }) {
      if (!Number.isInteger(keep) || keep < 1) throw new NeonAdminError("NEON_ADMIN_CONFIG", "Prune must keep at least one branch.");
      const candidates = (await admin.listBranches(project(projectId)))
        .filter((b) => b.name.startsWith(prefix) && namePattern.test(b.name))
        // Newest first; the timestamp in the name breaks ties and covers a missing created_at.
        .sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0) || (a.name < b.name ? 1 : -1));
      const stale = candidates.slice(keep);
      let failed = 0;
      for (const branch of stale) {
        try { await admin.deleteBranch(projectId, branch.id, [prefix]); } catch { failed += 1; }
      }
      if (failed) {
        throw new NeonAdminError("NEON_ADMIN_PRUNE_FAILED", `${failed} of ${stale.length} old snapshot branches could not be deleted. Check the Neon console; the free plan has a branch limit.`);
      }
      return { kept: Math.min(keep, candidates.length), deleted: stale.length };
    },
  };
  return admin;
}
