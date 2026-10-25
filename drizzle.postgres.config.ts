import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/postgres/schema.ts",
  out: "./db/postgres-migrations",
});
