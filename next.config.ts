import type { NextConfig } from "next";

const config: NextConfig = {
  // `pnpm dev` and a production build share `.next` and can corrupt each other. Set NEXT_DIST_DIR (for example
  // `.next-build`) when building or serving a production build while a dev server is running.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["better-sqlite3", "exceljs", "pdfmake", "sharp"],
  poweredByHeader: false,
  // Server-only (not NEXT_PUBLIC): inlined into server code at build time for /api/health.
  env: { APP_RELEASE_SHA: process.env.APP_RELEASE_SHA ?? "" },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "Cache-Control", value: "private, no-store" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
    ] }];
  },
  // Photos are resized on the phone to a few hundred KB; the default 1 MB limit is too tight for a large one.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  outputFileTracingIncludes: {
    "/**": ["./data/**/*", "./db/migrations/**/*"],
  },
};

export default config;
