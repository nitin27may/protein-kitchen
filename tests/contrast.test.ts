import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve(__dirname, "..", "app", "globals.css"), "utf8");

function vars(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

function blockAfter(marker: string): string {
  const i = css.indexOf(marker);
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  return "";
}

const themes = {
  light: vars(blockAfter(":root {")),
  dark: vars(blockAfter(':root[data-theme="dark"]')),
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// Text pairs that appear in the UI. WCAG AA needs 4.5:1 for body text.
const TEXT: [string, string][] = [
  ["fg", "bg"], ["fg", "surface"], ["fg", "surface-2"],
  ["muted", "bg"], ["muted", "surface"], ["muted", "surface-2"], ["muted", "primary-soft"],
  ["primary", "bg"], ["primary", "surface"], ["primary", "surface-2"], ["primary", "primary-soft"],
  ["primary-fg", "primary"],
  ["ok", "ok-soft"], ["ok", "surface"], ["ok", "bg"],
  ["warn", "warn-soft"], ["warn", "surface"], ["warn", "bg"],
  ["bad", "bad-soft"], ["bad", "surface"], ["bad", "bg"],
];

describe.each(Object.keys(themes) as (keyof typeof themes)[])("%s theme contrast", (name) => {
  const t = themes[name];
  it("defines every token", () => {
    for (const k of ["bg", "surface", "surface-2", "fg", "muted", "line", "line-strong", "primary", "primary-fg", "primary-soft", "ok", "ok-soft", "warn", "warn-soft", "bad", "bad-soft"]) {
      expect(t[k], `--${k}`).toBeDefined();
    }
  });
  it.each(TEXT)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it("control borders are at least 3:1 against their surface", () => {
    expect(ratio(t["line-strong"]!, t["surface"]!)).toBeGreaterThanOrEqual(3);
    expect(ratio(t["line-strong"]!, t["bg"]!)).toBeGreaterThanOrEqual(3);
  });
});

describe("system dark block matches the explicit dark block", () => {
  it("has the same values", () => {
    const sys = vars(blockAfter(":root:not([data-theme=\"light\"])"));
    expect(sys).toEqual(themes.dark);
  });
});
