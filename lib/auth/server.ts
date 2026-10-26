import { getBlobStore } from "../blob";
import { getDb } from "../server/context";
import { authConfiguration } from "./config";
import { createAuth } from "./create";
import { resendAuthSender } from "./mail";
import { limitedSender } from "./mail-limits";
import { localTestAuthSender } from "./test-mail";

let instance: {
  auth: ReturnType<typeof createAuth>;
  sendAssociation: (email: string) => Promise<void>;
} | undefined;

async function configuredAuth() {
  if (!instance) {
    const config = authConfiguration(process.env);
    const transport = process.env.AUTH_TEST_MAILBOX
      ? localTestAuthSender(process.env) : resendAuthSender(process.env);
    const db = await getDb();
    const sendMail = limitedSender(db, { secret: config.secret, dailyCap: config.mailDailyCap, allowlist: config.signupAllowlist }, transport);
    instance = {
      auth: createAuth(db, {
        ...config, sendCode: sendMail, sendLink: sendMail,
        deletePhotoKeys: async (keys) => {
          const store = getBlobStore();
          const results = await Promise.allSettled(keys.map((key) => store.delete(key)));
          if (results.some((result) => result.status === "rejected")) throw new Error("Some photo files were not removed.");
        },
      }),
      sendAssociation: (email) => sendMail({
        email, url: new URL("/sign-in", config.baseURL).toString(), type: "household-association",
      }),
    };
  }
  return instance;
}

export async function getAuth() {
  return (await configuredAuth()).auth;
}

export async function sendHouseholdAssociationNotice(email: string) {
  return (await configuredAuth()).sendAssociation(email);
}
