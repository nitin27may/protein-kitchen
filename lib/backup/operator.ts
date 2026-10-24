import { vaultConfiguration } from "./config";
import { fetchEncryptedVault, publishEncryptedVault } from "./vault";
import { openPrivateStateRepository } from "../sync/github";

/** Dependency injection is test-only; the operator script always uses the pinned production transport. */
export async function runVaultCommand(
  argv: string[], env: Readonly<Record<string, string | undefined>>,
  connect = openPrivateStateRepository,
): Promise<string[]> {
  const [command, ...args] = argv;
  if (!((command === "publish" && args.length === 2 && args[0] && args[1] === "--trust-artifact") ||
      (command === "fetch" && args.length === 3 && args.every(Boolean)))) {
    throw new Error("Invalid vault command.");
  }
  const config = vaultConfiguration(env);
  const open = () => connect(config);
  if (command === "publish") {
    const result = await publishEncryptedVault(args[0]!, true, open);
    return [`Encrypted vault publication verified: ${result.id} at ${result.commit} (${result.changed ? "published" : "already present"}).`];
  }
  const result = await fetchEncryptedVault(args[0]!, args[1]!, args[2]!, open);
  return [
    `Encrypted vault download verified: ${result.id} at ${result.commit}.`,
    "Ciphertext integrity is not source trust. Use the separate guarded restore only for an owner-approved artifact.",
  ];
}
