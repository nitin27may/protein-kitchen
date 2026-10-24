import { getDb } from "../server/context";
import { authConfiguration } from "./config";
import { createAuth } from "./create";
import { resendAuthSender } from "./mail";
import { localTestAuthSender } from "./test-mail";

let instance: ReturnType<typeof createAuth> | undefined;

export async function getAuth() {
  if (!instance) {
    const config = authConfiguration(process.env);
    const sendMail = process.env.AUTH_TEST_MAILBOX
      ? localTestAuthSender(process.env) : resendAuthSender(process.env);
    instance = createAuth(await getDb(), { ...config, sendCode: sendMail, sendLink: sendMail });
  }
  return instance;
}
