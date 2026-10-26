import { describe, expect, it } from "vitest";
import { shouldInitializeFeedback } from "../lib/db/postgres/seed-target";

describe("seed feedback parity", () => {
  it.each(["postgres://localhost/x", "postgres://127.0.0.1:5432/x", "postgres://[::1]/x"])("initialises on loopback %s", (connectionString) => {
    expect(shouldInitializeFeedback({ connectionString, databaseEnvironment: "test" })).toBe(true);
    expect(shouldInitializeFeedback({ connectionString, databaseEnvironment: "development" })).toBe(true);
  });
  it("never initialises for remote targets, rehearsals or production", () => {
    expect(shouldInitializeFeedback({ connectionString: "postgres://ep-x.neon.tech/x", databaseEnvironment: "development" })).toBe(false);
    expect(shouldInitializeFeedback({ connectionString: "postgres://ep-x.neon.tech/x", databaseEnvironment: "preview" })).toBe(false);
    expect(shouldInitializeFeedback({ connectionString: "postgres://localhost/x", databaseEnvironment: "production" })).toBe(false);
    expect(shouldInitializeFeedback({ connectionString: "not a url", databaseEnvironment: "test" })).toBe(false);
  });
});
