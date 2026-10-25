"use client";

import { useEffect, useState } from "react";
import { Banner, Button } from "@/components/ui";

type Status = "checking" | "unsupported" | "needs-install" | "not-configured" | "denied" | "off" | "on";

function toKey(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export function ReminderSettings({ personId, personName, publicKey, hasTime }: { personId: number; personName: string; publicKey: string | null; hasTime: boolean }) {
  const [status, setStatus] = useState<Status>("checking");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
      if (ios && !standalone) return setStatus("needs-install");
      if (!supported) return setStatus("unsupported");
      if (!publicKey) return setStatus("not-configured");
      if (Notification.permission === "denied") return setStatus("denied");
      const sub = await currentSubscription();
      if (sub) {
        const r = await fetch(`/api/push/subscribe?personId=${personId}&endpoint=${encodeURIComponent(sub.endpoint)}`).then((x) => x.json()).catch(() => ({ subscribed: false }));
        return setStatus(r.subscribed ? "on" : "off");
      }
      setStatus("off");
    })();
  }, [personId, publicKey]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        setMsg({ tone: "info", text: "Notifications were not allowed, so reminders stay off." });
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
      const json = sub.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId, endpoint: json.endpoint, keys: json.keys }),
      });
      if (!res.ok) throw new Error("The server did not accept the subscription.");
      setStatus("on");
      setMsg({ tone: "ok", text: `Reminders are on for ${personName} on this device.` });
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Could not turn reminders on." });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      const sub = await currentSubscription();
      if (sub) {
        const response = await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        if (!response.ok) throw new Error("The server could not disable this device. Try again.");
        await sub.unsubscribe();
      }
      setStatus("off");
      setMsg({ tone: "info", text: "Reminders are off on this device." });
    } catch {
      setMsg({ tone: "bad", text: "Reminders could not be disabled. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personId }) }).then((r) => r.json()).catch(() => ({ ok: false, error: "Could not reach the server." }));
    setMsg(res.ok ? { tone: "ok", text: "Test sent. It should arrive in a few seconds." } : { tone: "bad", text: res.error ?? "Test failed." });
    setBusy(false);
  }

  return (
    <section aria-labelledby="rem" className="rounded-card border border-line bg-surface2 p-4">
      <h2 id="rem" className="text-base font-semibold">Reminders on this device</h2>
      {!hasTime ? <p className="mt-1 text-sm text-muted">Set a reminder time above and save first. Then turn reminders on here.</p> : null}
      <div className="mt-2 space-y-3" aria-live="polite">
        {status === "checking" ? <p className="text-sm text-muted">Checking this device…</p> : null}
        {status === "unsupported" ? <Banner tone="info">This browser cannot receive reminders. Try Chrome, Edge or Safari, or install the app on your phone.</Banner> : null}
        {status === "needs-install" ? (
          <Banner tone="info" title="Add the app to your Home Screen first">
            On iPhone, reminders only work for the installed app. In Safari tap Share, then Add to Home Screen, open the app from there, and come back to this page.
          </Banner>
        ) : null}
        {status === "not-configured" ? <Banner tone="warn" title="Reminders are not set up on the server">The server needs VAPID keys. See .env.example in the project.</Banner> : null}
        {status === "denied" ? <Banner tone="warn" title="Notifications are blocked">Allow notifications for this site in your browser settings, then come back.</Banner> : null}
        {status === "off" ? <Button onClick={enable} disabled={busy} className="w-full">{busy ? "Turning on…" : "Turn on reminders"}</Button> : null}
        {status === "on" ? (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={test} disabled={busy}>Send a test</Button>
            <Button variant="ghost" className="flex-1" onClick={disable} disabled={busy}>Turn off</Button>
          </div>
        ) : null}
        {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      </div>
    </section>
  );
}
