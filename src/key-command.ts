import { describeKeys, promote, retire, rotate, type StepResult } from "./key-rotation.ts";
import { readKeyFile, replaceKeyFile } from "./keys.ts";

export const keyCommandUsage = `Usage: node src/bin/keys.ts <command> [option]

Commands, run with DATA_DIR set, each followed by a broker restart:

  list                  List the keys and what each does.
  rotate                Publish a new signing key, and start a new cookie key.
  promote [--skip-wait] Start signing with the new signing key.
  retire [--skip-wait]  Remove old keys that nothing in use depends on.

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
    rotate: [],
  };
  const allowedFlags = command === undefined ? undefined : allowed[command];
  if (allowedFlags === undefined || flags.some((flag) => !allowedFlags.includes(flag))) {
    options.printError(keyCommandUsage);
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
    default:
      return write(options, retire(file, { now, skipWait }));
  }
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
