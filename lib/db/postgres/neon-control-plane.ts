import { z } from "zod";
import { ProductionGuardError } from "./production-guard";

const branchSchema = z.object({
  id: z.string(), project_id: z.string(), name: z.string().min(1), current_state: z.string(),
});
const endpointSchema = z.object({
  id: z.string(), host: z.string(), branch_id: z.string(), project_id: z.string(), type: z.string(),
});
const listedBranchSchema = z.object({ id: z.string(), name: z.string(), created_at: z.string() });

export type NeonBranch = z.infer<typeof branchSchema>;
export type NeonEndpoint = z.infer<typeof endpointSchema>;
export type NeonListedBranch = z.infer<typeof listedBranchSchema>;

/** Read-only view of the Neon control plane. Tests inject a fake; production code uses `neonHttpControlPlane`. */
export interface NeonControlPlane {
  project(projectId: string): Promise<{ id: string }>;
  branch(projectId: string, branchId: string): Promise<NeonBranch>;
  endpoints(projectId: string, branchId: string): Promise<NeonEndpoint[]>;
  branches(projectId: string): Promise<NeonListedBranch[]>;
}

/** GET-only, fixed origin, no redirects, timeouts, and no response body in any error. */
export function neonHttpControlPlane(apiKey: string, request: typeof fetch = fetch): NeonControlPlane {
  async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await request(`https://console.neon.tech/api/v2${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error",
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProductionGuardError("PRODUCTION_NEON_UNREACHABLE", "The Neon control plane could not be reached.");
    }
    if (!response.ok) throw new ProductionGuardError("PRODUCTION_NEON_UNREACHABLE", `The Neon control plane answered HTTP ${response.status}.`);
    let body: unknown;
    try { body = await response.json(); } catch {
      throw new ProductionGuardError("PRODUCTION_NEON_INVALID", "The Neon control plane returned invalid JSON.");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProductionGuardError("PRODUCTION_NEON_INVALID", "The Neon control plane returned incomplete metadata.");
    return parsed.data;
  }
  return {
    project: async (id) => (await read(`/projects/${id}`, z.object({ project: z.object({ id: z.string() }) }))).project,
    branch: async (project, id) => (await read(`/projects/${project}/branches/${id}`, z.object({ branch: branchSchema }))).branch,
    endpoints: async (project, id) =>
      (await read(`/projects/${project}/branches/${id}/endpoints`, z.object({ endpoints: z.array(endpointSchema) }))).endpoints,
    branches: async (project) => (await read(`/projects/${project}/branches`, z.object({ branches: z.array(listedBranchSchema) }))).branches,
  };
}
