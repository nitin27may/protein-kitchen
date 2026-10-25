import { previewPreflight } from "../lib/deployment/preflight";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--verify-branch")) throw new Error("Invalid preflight arguments.");
  const report = await previewPreflight(process.env, args.length === 1);
  console.log(JSON.stringify(report));
  console.log("Read-only configuration evidence, not deployment approval. Preview mail/push/sync/vault remain disabled; provider, live storage, protected hosting and recovery acceptance are separate gates.");
  if (report.failed.length) process.exitCode = 1;
}
main().catch(() => {
  console.error("Protected-preview preflight failed. Check explicit environment and arguments; no deployment or database writes occurred.");
  process.exitCode = 1;
});
