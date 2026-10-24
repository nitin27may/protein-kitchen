"use client";

import { useEffect, useRef, useState } from "react";
import { previewFeasibility } from "@/app/actions";
import type { FeasibilityInput, FeasibilityResult } from "@/lib/planner/feasibility-types";

export type FeasibilityState =
  | { status: "idle"; result: null; message: null }
  | { status: "loading"; result: FeasibilityResult | null; message: null }
  | { status: "ready"; result: FeasibilityResult; message: null }
  | { status: "error"; result: FeasibilityResult | null; message: string };

const IDLE: FeasibilityState = { status: "idle", result: null, message: null };

/**
 * Asks the server what the planner could do with these choices, without making a plan. Waits for the choices to settle
 * (debounce), ignores answers that arrive after newer choices, and keeps the last answer on screen while it checks.
 * Pass `null` when the choices are not complete enough to check.
 */
export function useFeasibility(input: FeasibilityInput | null, key: string, delayMs = 400): FeasibilityState {
  const [state, setState] = useState<FeasibilityState>(IDLE);
  const seq = useRef(0);
  const last = useRef<FeasibilityResult | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const current = inputRef.current;
    const mine = ++seq.current;
    if (!current) {
      setState(IDLE);
      return;
    }
    setState({ status: "loading", result: last.current, message: null });
    const timer = setTimeout(() => {
      previewFeasibility(current)
        .then((res) => {
          if (mine !== seq.current) return;
          if (res.ok) {
            last.current = res.result;
            setState({ status: "ready", result: res.result, message: null });
          } else setState({ status: "error", result: last.current, message: res.error });
        })
        .catch(() => {
          if (mine === seq.current) setState({ status: "error", result: last.current, message: "Could not check this plan." });
        });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs]);

  return state;
}
