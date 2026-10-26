import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import config, { PDF_FONT_GLOBS, PDF_ROUTES } from "../next.config";

// Minimal stand-in for Next's picomatch use: only "*" (one path segment) and literals are needed here.
const picomatch = (glob: string) => {
  const re = new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  return (value: string) => re.test(value);
};

const FONTS = ["Roboto-Regular.ttf", "Roboto-Medium.ttf", "Roboto-Italic.ttf", "Roboto-MediumItalic.ttf"];

describe("pdfmake font tracing", () => {
  it("includes the Roboto fonts for every route that builds a PDF", () => {
    const includes = config.outputFileTracingIncludes ?? {};
    for (const route of ["/api/plan/[id]/export", "/api/plan/[id]/schedule"]) {
      const keys = Object.keys(includes).filter((key) => key !== "/**" && picomatch(key)(route));
      expect(keys.length, `no tracing include matches ${route}`).toBeGreaterThan(0);
      for (const key of keys) expect(includes[key]).toEqual(expect.arrayContaining(PDF_FONT_GLOBS));
    }
    expect(PDF_ROUTES).toHaveLength(2);
    expect(PDF_FONT_GLOBS.join()).toContain("pdfmake/build/fonts/Roboto");
  });

  it("keeps the catch-all data include", () => {
    expect(config.outputFileTracingIncludes?.["/**"]).toContain("./data/**/*");
  });

  it("finds the font files pdf.ts loads, with plausible sizes", () => {
    const dir = path.join(path.dirname(createRequire(path.join(process.cwd(), "package.json")).resolve("pdfmake/package.json")), "build", "fonts", "Roboto");
    for (const name of FONTS) {
      const file = path.join(dir, name);
      expect(fs.existsSync(file), name).toBe(true);
      expect(fs.statSync(file).size, name).toBeGreaterThan(50_000);
    }
  });

  it("the include glob matches the font files under the project root", () => {
    const dir = path.join(process.cwd(), "node_modules", "pdfmake", "build", "fonts", "Roboto");
    const matcher = picomatch(PDF_FONT_GLOBS[0]!.replace(/^\.\//, ""));
    for (const name of FONTS) expect(matcher(path.posix.join("node_modules/pdfmake/build/fonts/Roboto", name))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(expect.arrayContaining(FONTS));
  });
});

describe("export route PDF failure", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/export/pdf");
  });

  it("returns a generic private 500 and logs a code, not the path", async () => {
    vi.doMock("@/lib/auth/access", () => ({ routeAccess: async () => ({ response: null }) }));
    vi.doMock("@/lib/server/export", () => ({ getPlanExport: async () => ({ startDate: "2026-11-02" }) }));
    vi.doMock("@/lib/export/xlsx", () => ({ buildWorkbook: async () => Buffer.alloc(0) }));
    vi.doMock("@/lib/export/pdf", () => ({
      buildPdf: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, open '/var/task/secret/Roboto-Medium.ttf'"), { code: "ENOENT" });
      },
    }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../app/api/plan/[id]/export/route");
    const res = await GET(new Request("http://x/api/plan/1/export?format=pdf"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: false, error: "The PDF could not be built. Try again later." });
    expect(log).toHaveBeenCalledWith("Plan export failed.", { format: "pdf", code: "ENOENT" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("/var/task");
  });
});
