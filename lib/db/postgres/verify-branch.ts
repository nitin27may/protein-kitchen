import { z } from "zod";
import { validatePostgresTarget } from "./target";
import type { PostgresTarget } from "./target";

const branchResponse = z.object({
  branch: z.object({
    id: z.string(), project_id: z.string(), name: z.string().min(1),
    default: z.boolean(), primary: z.boolean(), protected: z.boolean(), current_state: z.string(),
  }),
});
const endpointsResponse = z.object({
  endpoints: z.array(z.object({
    id: z.string(), host: z.string(), branch_id: z.string(), project_id: z.string(), type: z.string(),
  })),
});

type Environment = Readonly<Record<string, string | undefined>>;

/** Live control-plane verification before creating a non-production remote pool. Never opens Postgres. */
export async function verifyNonProductionBranch(target: PostgresTarget, env: Environment, request: typeof fetch = fetch): Promise<void> {
  const url = validatePostgresTarget(target);
  if (target.runtimeEnvironment === "production" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  if (!url.hostname.endsWith(".neon.tech") || (url.port && url.port !== "5432")) {
    throw new Error("Remote non-production databases currently require a verified Neon endpoint on port 5432.");
  }
  const { NEON_PROJECT_ID: project, NEON_DEVELOPMENT_BRANCH_ID: development, NEON_PRODUCTION_BRANCH_ID: production, NEON_API_KEY: apiKey } = env;
  if (!project || !development || !production || !apiKey) {
    throw new Error("Remote non-production Postgres requires NEON_PROJECT_ID, NEON_DEVELOPMENT_BRANCH_ID, NEON_PRODUCTION_BRANCH_ID and a server-only NEON_API_KEY.");
  }
  if (!/^[a-z0-9-]+$/.test(project) || !/^br-[a-z0-9-]+$/.test(development) || !/^br-[a-z0-9-]+$/.test(production)) {
    throw new Error("Neon verification requires explicit project and branch ids, not names or paths.");
  }
  if (development === production) throw new Error("The production branch must never be selected for non-production.");

  const read = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(`https://console.neon.tech/api/v2${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error",
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Neon branch verification could not reach the control plane. No database pool was opened; retry when available.");
    }
    if (!response.ok) {
      throw new Error(`Neon branch verification failed (HTTP ${response.status}). Check API access and branch configuration; no database pool was opened.`);
    }
    try { return await response.json(); } catch {
      throw new Error("Neon branch verification returned invalid JSON. No database pool was opened.");
    }
  };
  const path = `/projects/${project}/branches/${development}`;
  const parsedBranch = branchResponse.safeParse(await read(path));
  if (!parsedBranch.success) throw new Error("Neon branch verification returned incomplete branch metadata.");
  const branch = parsedBranch.data.branch;
  if (branch.id !== development || branch.project_id !== project ||
      branch.default || branch.primary || branch.protected ||
      /^(?:prod(?:uction)?|main|master)$/i.test(branch.name.trim()) || branch.current_state !== "ready") {
    throw new Error("Neon non-production target must be a ready, non-default, non-primary, unprotected development branch, never production.");
  }
  const parsedEndpoints = endpointsResponse.safeParse(await read(`${path}/endpoints`));
  if (!parsedEndpoints.success) throw new Error("Neon branch verification returned incomplete endpoint metadata.");
  const matches = parsedEndpoints.data.endpoints.filter((endpoint) => {
    const [label, ...domain] = endpoint.host.split(".");
    const pooledHost = `${label}-pooler.${domain.join(".")}`;
    return endpoint.project_id === project && endpoint.branch_id === development && endpoint.type === "read_write" &&
      endpoint.host.endsWith(".neon.tech") && label === endpoint.id &&
      (url.hostname === endpoint.host || url.hostname === pooledHost);
  });
  if (matches.length !== 1) {
    throw new Error("Postgres host is not a unique read-write endpoint of the verified Neon development branch.");
  }
}
