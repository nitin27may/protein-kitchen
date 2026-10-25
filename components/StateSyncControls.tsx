"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncSharedState } from "@/app/settings/sync-actions";
import type { stateSyncSettings } from "@/lib/sync/server";
import { Banner, Button } from "@/components/ui";

export function StateSyncControls({ settings }: { settings: Awaited<ReturnType<typeof stateSyncSettings>> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return <section aria-label="Private shared-state sync" className="space-y-3 rounded-card border border-line bg-surface p-4">
    <h2 className="text-lg font-semibold">Private shared-state sync</h2>
    <p className="text-sm text-muted">Copies only explicitly selected shared library choices and approved processed photos to the owner's private repository. Profiles, health requirements, identities, private feedback, routines and meal history are excluded. Shared free text and photos can still be sensitive. This is not a full recovery backup.</p>
    {!settings.enabled ? <p className="text-sm text-muted">{settings.reason}</p> : <>
      <p className="text-sm">Status: {settings.run.status === "running" && !settings.run.active ? "interrupted; retry to recover" : settings.run.status}</p>
      <p className="text-sm">Last successful sync: {settings.run.lastSuccessAt ?? "Never"}</p>
      {settings.run.errorCode && !error ? <Banner tone="bad">{settings.run.status === "conflict" ? "Conflicting repository changes need owner reconciliation. No overwrite was forced." : "The last attempt did not complete. Retry to reconcile any saved remote snapshot safely."}</Banner> : null}
      <ul className="text-sm">{settings.classes.map((item) => <li key={item.dataClass}>{item.dataClass}: {item.pending ? "pending" : "synced"}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" loading={pending} disabled={settings.run.active} onClick={() => start(async () => {
          setError(""); setMessage("");
          try {
            const result = await syncSharedState();
            if (result.ok) setMessage(result.message); else setError(result.error);
          } catch { setError("Sync could not be reached. Check your connection, refresh and retry."); }
          router.refresh();
        })}>Sync now</Button>
        <Button className="min-h-11" variant="secondary" disabled={pending} onClick={() => router.refresh()}>Refresh sync status</Button>
      </div>
    </>}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
    {error ? <Banner tone="bad">{error}</Banner> : null}
  </section>;
}
