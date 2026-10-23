import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "exceljs", "pdfmake"],
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/**": ["./data/**/*", "./db/migrations/**/*"],
  },
};

export default config;
