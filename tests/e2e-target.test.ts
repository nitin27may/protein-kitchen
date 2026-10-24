import { describe, expect, it } from "vitest";
import { e2eTarget } from "./e2e/target";

describe("browser fixture database guard", () => {
  it.each([
    undefined, "not a URL", "postgres://localhost/production", "postgres://localhost/protein_kitchen_test",
    "postgres://ep-production.neon.tech/protein_kitchen_e2e",
    "postgres://localhost/protein_kitchen_e2e?host=ep-production.neon.tech",
  ])("refuses unsafe/missing browser database selection (%#)", (url) => {
    expect(() => e2eTarget(url)).toThrow();
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])("accepts only the explicit loopback browser database (%s)", (host) => {
    expect(e2eTarget(`postgres://fixture@${host}/protein_kitchen_e2e`).databaseEnvironment).toBe("test");
  });
});
