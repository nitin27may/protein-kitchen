import { VaultError } from "../lib/backup/vault";
import { runVaultCommand } from "../lib/backup/operator";

async function main() {
  for (const message of await runVaultCommand(process.argv.slice(2), process.env)) console.log(message);
}
main().catch((error: unknown) => {
  console.error(error instanceof VaultError ? error.message :
    "Vault operation failed. Check explicit operator arguments, separate pinned private vault configuration and connectivity. Preserve the local artifact for same-id retry; no completed backup/recovery was reported.");
  process.exitCode = 1;
});
