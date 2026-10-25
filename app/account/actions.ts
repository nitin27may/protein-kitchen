"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Result } from "@/app/actions";
import { actionDenial } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/server";
import { CurrentPassword, NewPassword, type PasswordOutcome } from "@/lib/auth/password";

const messages: Record<Extract<PasswordOutcome, { ok: false }>["reason"], string> = {
  unauthenticated: "Sign in again before changing your password.",
  "rate-limited": "Too many attempts. Wait a minute before trying again.",
  "already-set": "A password is already set. Use Change password instead.",
  "wrong-current": "Your current password is not correct.",
  "no-password": "No password is set yet. Use Set a password instead.",
  unavailable: "The password could not be saved. Try again.",
};

function finish(outcome: PasswordOutcome): Result {
  if (outcome.ok) { revalidatePath("/account"); return { ok: true }; }
  return { ok: false, error: messages[outcome.reason] };
}

function invalid(error: z.ZodError): Result {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) fields[String(issue.path[0] ?? "form")] ??= issue.message;
  return { ok: false, error: "Check the marked fields and try again.", fields };
}

/** For accounts created by email code, which have no password yet. The target is always the session's own user. */
export async function setAccountPassword(input: { newPassword: string }): Promise<Result> {
  const denied = await actionDenial(); if (denied) return denied;
  const parsed = z.object({ newPassword: NewPassword }).strict().safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const auth = await getAuth();
  return finish(await auth.api.setPassword({ headers: await headers(), newPassword: parsed.data.newPassword }));
}

export async function changeAccountPassword(input: { currentPassword: string; newPassword: string }): Promise<Result> {
  const denied = await actionDenial(); if (denied) return denied;
  const parsed = z.object({ currentPassword: CurrentPassword, newPassword: NewPassword }).strict().safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return { ok: false, error: "Check the marked fields and try again.", fields: { newPassword: "Choose a password different from the current one." } };
  }
  const auth = await getAuth();
  return finish(await auth.api.changePassword({ headers: await headers(), ...parsed.data }));
}
