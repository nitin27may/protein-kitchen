import { readFile, stat, unlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { localTestCodeSender, testMailPath } from "../lib/auth/test-mail";

const env = {
  NODE_ENV: "development", DATABASE_ENV: "development", AUTH_TEST_MAILBOX: "1",
  DATABASE_URL: "postgres://fixture@127.0.0.1:54329/protein_kitchen_e2e",
};
describe("synthetic-only local auth mailbox", () => {
  it.each([
    { AUTH_TEST_MAILBOX: "" }, { AUTH_TEST_MAILBOX: "yes" }, { NODE_ENV: "production" }, { DATABASE_ENV: "production" }, { VERCEL: "1" },
    { DATABASE_URL: undefined }, { DATABASE_URL: "" }, { DATABASE_URL: "postgres://fixture@127.0.0.1:54329/household" },
    { DATABASE_URL: "postgres://fixture@remote.example.test/protein_kitchen_e2e" },
    { DATABASE_URL: "postgres://fixture@127.0.0.1/protein_kitchen_e2e?host=remote.example.test" },
  ])("refuses unsafe configuration before writing (%j)", (override) => {
    expect(() => localTestCodeSender({ ...env, ...override })).toThrow();
  });
  it("only writes reserved synthetic addresses, privately and atomically", async () => {
    const send = localTestCodeSender(env);
    await expect(send({ email: "not-a-fixture@external.example", otp: "123456", type: "sign-in" })).rejects.toThrow("example.test");
    const mail = { email: "mail-unit-fixture@example.test", otp: "123456", type: "sign-in" as const };
    const file = testMailPath(mail.email, mail.type);
    try {
      await send(mail);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(mail);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await send({ ...mail, otp: "654321" });
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ otp: "654321" });
    } finally { await unlink(file); }
  });
});
