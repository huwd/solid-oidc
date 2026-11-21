import { join } from "node:path";

import { databaseFileName, openDatabase } from "./database.ts";
import { describeKeys, promote, retire, revoke, rotate, type StepResult } from "./key-rotation.ts";
import { type KeyFile, readKeyFile, replaceKeyFile } from "./keys.ts";

export const keyCommandUsage = `Usage: node src/bin/keys.ts <command> [option]

Commands, run with DATA_DIR set, each followed by a broker restart:

  list                  List the keys and what each does.
  rotate                Publish a new signing key, and start a new cookie key.
  promote [--skip-wait] Start signing with the new signing key.
  retire [--skip-wait]  Remove old keys that nothing in use depends on.
  revoke --confirm      Replace every key and log everyone out, for leaked keys.

--skip-wait removes or uses a key before it is safe to. Tokens or sessions
that depend on it stop working.`;

export type KeyCommandOptions = {
  readonly args: readonly string[];
  readonly dataDir: string;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
};

/** Run a key command, and return the process exit code. */
export async function runKeyCommand(options: KeyCommandOptions): Promise<number> {
  const [command, ...flags] = options.args;
  const skipWait = flags.includes("--skip-wait");
  const allowed: Readonly<Record<string, readonly string[]>> = {
    list: [],
    promote: ["--skip-wait"],
    retire: ["--skip-wait"],
    revoke: ["--confirm"],
    rotate: [],
  };
  const allowedFlags = command === undefined ? undefined : allowed[command];
  if (allowedFlags === undefined || flags.some((flag) => !allowedFlags.includes(flag))) {
    options.printError(keyCommandUsage);
    return 2;
  }
  if (command === "revoke" && !flags.includes("--confirm")) {
    options.printError(
      "revoke logs everyone out and invalidates every token. Run it with --confirm if the keys may have leaked.",
    );
    return 2;
  }

  const read = await readKeyFile(options.dataDir);
  if (!read.ok) {
    return fail(options, read.errors);
  }
  const file = read.value;
  const now = options.now();

  switch (command) {
    case "list":
      for (const line of describeKeys(file)) {
        options.print(line);
      }
      return 0;
    case "rotate":
      return write(options, rotate(file, { now }));
    case "promote":
      return write(options, promote(file, { now, skipWait }));
    case "retire":
      return write(options, retire(file, { now, skipWait }));
    default:
      return revokeEverything(options, file, now);
  }
}

// Delete the stored state before replacing the keys. Whoever copied the key
// file has probably copied the database beside it, and its refresh tokens
// would otherwise get new tokens signed with the new key.
async function revokeEverything(
  options: KeyCommandOptions,
  file: KeyFile,
  now: number,
): Promise<number> {
  const opened = openDatabase({ now: options.now, path: join(options.dataDir, databaseFileName) });
  if (!opened.ok) {
    return fail(options, opened.errors);
  }
  let removed: number;
  {
    using database = opened.value;
    removed = database.removeAll();
  }
  options.print(`Deleted ${removed} sessions, grants, codes and tokens.`);
  return write(options, revoke(file, { now }));
}

async function write(options: KeyCommandOptions, step: StepResult): Promise<number> {
  if (!step.ok) {
    return fail(options, step.errors);
  }
  const written = await replaceKeyFile(options.dataDir, step.value.file);
  if (!written.ok) {
    return fail(options, written.errors);
  }
  for (const change of step.value.changes) {
    options.print(change);
  }
  options.print("Restart the broker to use the changed keys.");
  return 0;
}

function fail(options: KeyCommandOptions, errors: readonly string[]): number {
  for (const error of errors) {
    options.printError(error);
  }
  return 1;
}
