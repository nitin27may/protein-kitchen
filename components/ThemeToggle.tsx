"use client";

import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const ORDER: Mode[] = ["system", "light", "dark"];
const LABEL: Record<Mode, string> = { system: "Auto", light: "Light", dark: "Dark" };

function apply(mode: Mode) {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function ThemeToggle({ variant = "button" }: { variant?: "button" | "segmented" }) {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pk-theme");
      if (saved === "light" || saved === "dark") setMode(saved);
    } catch {
      /* storage can be blocked; the system theme is a fine default */
    }
  }, []);

  function next() {
    choose(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!);
  }

  function choose(m: Mode) {
    setMode(m);
    apply(m);
    try {
      if (m === "system") localStorage.removeItem("pk-theme");
      else localStorage.setItem("pk-theme", m);
    } catch {
      /* ignore */
    }
  }

  if (variant === "segmented") {
    return (
      <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-3 gap-1 rounded-control border border-line bg-surface2 p-1">
        {ORDER.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => choose(m)}
            className={`min-h-9 rounded-[0.5rem] text-sm font-semibold ${mode === m ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-fg"}`}>
            {LABEL[m]}
          </button>
        ))}
      </div>
    );
  }

  return (
    <button type="button" onClick={next} aria-label={`Colour theme: ${LABEL[mode]}. Tap to change.`} className="flex min-h-11 items-center rounded-control px-3 text-base font-semibold text-muted hover:bg-surface2">
      {LABEL[mode]}
    </button>
  );
}
