import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Step { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }
export interface Job {
  if?: string; needs?: string | string[]; environment?: string; permissions?: Record<string, string>; env?: Record<string, string>
  concurrency?: { group: string; "cancel-in-progress": boolean }; "timeout-minutes"?: number; steps: Step[]; outputs?: Record<string, string>
}
export interface Workflow {
  name: string; on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job>
}

export function loadWorkflow(name: string): { text: string; workflow: Workflow } {
  const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
  return { text, workflow: parse(text) as Workflow };
}

export const allSteps = (workflow: Workflow): Step[] => Object.values(workflow.jobs).flatMap((job) => job.steps);

/** Index of the first step at or after `from` whose command contains `needle`. */
export function indexOfCommand(steps: readonly Step[], needle: string, from = 0): number {
  return steps.findIndex((step, index) => index >= from && (step.run ?? "").includes(needle));
}

export function expectOrderedCommands(steps: readonly Step[], needles: readonly string[]): number[] {
  const found: number[] = [];
  let from = 0;
  for (const needle of needles) {
    const index = indexOfCommand(steps, needle, from);
    if (index < 0) throw new Error(`Missing or out of order: ${needle}`);
    found.push(index);
    from = index + 1;
  }
  return found;
}
