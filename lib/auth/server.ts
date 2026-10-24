import { getDb } from "../server/context";
import { authConfiguration } from "./config";
import { createAuth } from "./create";
import { resendCodeSender } from "./mail";
import { localTestCodeSender } from "./test-mail";

let instance: ReturnType<typeof createAuth> | undefined;

export async function getAuth() {
  if (!instance) {
    const config = authConfiguration(process.env);
    const sendCode = process.env.AUTH_TEST_MAILBOX
      ? localTestCodeSender(process.env) : resendCodeSender(process.env);
    instance = createAuth(await getDb(), { ...config, sendCode });
  }
  return instance;
}
