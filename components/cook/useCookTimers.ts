"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ADD_MS, extendTimer, needsAlert, parseTimers, serializeTimers, startTimer } from "@/lib/recipes/cooktimers";
import type { CookTimer } from "@/lib/recipes/cooktimers";
import { beep } from "./alert";

/**
 * Several kitchen timers at once. Each stores the moment it ends in sessionStorage, so a refresh, a locked phone or a
 * background tab cannot make it drift: the clock shown is always the end time minus now, read on every tick and when
 * the tab becomes visible again.
 */
export function useCookTimers(storageKey: string) {
  const [timers, setTimers] = useState<CookTimer[]>([]);
  const [now, setNow] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const loaded = useRef(false);

  useEffect(() => {
    setNow(Date.now());
    try {
      setTimers(parseTimers(sessionStorage.getItem(storageKey)));
    } catch {
      /* storage can be blocked; timers still work for this visit */
    }
    loaded.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(storageKey, serializeTimers(timers));
    } catch {
      /* ignore */
    }
  }, [timers, storageKey]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 250);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!now) return;
    const due = needsAlert(timers, now);
    if (!due.length) return;
    setTimers((ts) => ts.map((t) => (due.some((d) => d.id === t.id) ? { ...t, alerted: true } : t)));
    setAnnouncement(`Timer finished: ${due.map((t) => (t.partName ? `${t.label}, ${t.partName}` : t.label)).join("; ")}`);
    beep();
  }, [now, timers]);

  const add = useCallback((args: { stepId: string; label: string; partName: string | null; durationSec: number }) => {
    setTimers((ts) => [...ts, startTimer(args, Date.now())]);
  }, []);
  const addTime = useCallback((id: string) => setTimers((ts) => ts.map((t) => (t.id === id ? extendTimer(t, ADD_MS, Date.now()) : t))), []);
  const remove = useCallback((id: string) => setTimers((ts) => ts.filter((t) => t.id !== id)), []);

  return { timers, now, announcement, add, addTime, remove };
}
