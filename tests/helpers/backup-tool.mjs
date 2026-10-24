#!/usr/bin/env node
// Deliberately NOT encryption: unit-test stream/failure fixture. Native tests use the real age CLI.
if (process.argv.includes("--decrypt")) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 9).equals(Buffer.from("FAKE-AGE\n")) || process.argv.some((arg) => arg.endsWith("wrong-identity"))) {
    process.stderr.write("PRIVATE_DECRYPT_FAILURE"); process.exitCode = 1;
  } else process.stdout.write(bytes.subarray(9));
} else if (process.argv.includes("--single-transaction")) {
  process.stdin.resume();
} else if (process.argv.includes("--encrypt")) {
  process.stdout.write("FAKE-AGE\n");
  process.stdin.pipe(process.stdout);
} else if (process.env.PGDATABASE === "fail") {
  process.stderr.write("PRIVATE_DUMP_FAILURE");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2), host: process.env.PGHOST, port: process.env.PGPORT,
    database: process.env.PGDATABASE, user: process.env.PGUSER, ssl: process.env.PGSSLMODE,
    channelBinding: process.env.PGCHANNELBINDING, passfile: process.env.PGPASSFILE,
    rootCert: process.env.PGSSLROOTCERT,
    service: process.env.PGSERVICE, options: process.env.PGOPTIONS,
  }));
}
