// Rotate the provider's keys:
//
//   node src/bin/keys.ts <list|rotate|promote|retire> [option]
//
// It reads DATA_DIR from the environment, as the broker does. Restart the
// broker after each change. The README's "Rotating keys" section gives the
// procedure. Its logic is in key-command.ts, which is tested; see the note
// in main.ts.

import { keyCommandUsage, runKeyCommand } from "../key-command.ts";

const dataDir = process.env["DATA_DIR"];
if (dataDir === undefined) {
  console.error(`DATA_DIR must be set.\n\n${keyCommandUsage}`);
  process.exit(2);
}

process.exitCode = await runKeyCommand({
  args: process.argv.slice(2),
  dataDir,
  now: Date.now,
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
});
