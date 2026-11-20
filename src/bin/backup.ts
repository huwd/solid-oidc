// Back up the provider database while the broker runs:
//
//   node src/bin/backup.ts <destination>
//
// It reads DATA_DIR from the environment, as the broker does, and writes a
// consistent copy to a new file readable only by its owner. The image has no
// sqlite3 command, so this is the way to back up from inside the container.
// Its logic is in database.ts, which is tested; see the note in main.ts.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { databaseFileName, openDatabase } from "../database.ts";

const [destination] = process.argv.slice(2);
const dataDir = process.env["DATA_DIR"];
if (destination === undefined || dataDir === undefined) {
  console.error("Usage: DATA_DIR=<directory> node src/bin/backup.ts <destination>");
  process.exit(2);
}

const opened = openDatabase({ now: Date.now, path: join(dataDir, databaseFileName) });
if (!opened.ok) {
  for (const error of opened.errors) {
    console.error(error);
  }
  process.exit(1);
}

using database = opened.value;
// Backups hold live tokens, so their directory is the owner's alone.
mkdirSync(dirname(destination), { mode: 0o700, recursive: true });
const result = await database.backUp(destination);
if (!result.ok) {
  for (const error of result.errors) {
    console.error(error);
  }
  process.exit(1);
}
console.log(`Backed up ${join(dataDir, databaseFileName)} to ${destination}`);
