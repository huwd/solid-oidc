// Process entry point: reads the environment, starts the server and handles
// signals and exit codes. It cannot run under the test runner without
// replacing process globals, so the test script excludes src/bin/ from
// coverage. Keep logic out of this file; the functions it calls are tested.

import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { createApp } from "../app.ts";
import { loadOrCreateKeys } from "../keys.ts";
import { loadConfig } from "../load-config.ts";
import { createProvider } from "../provider.ts";
import { startServer } from "../server.ts";

function exitWithErrors(errors: readonly string[]): never {
  for (const error of errors) {
    console.error(JSON.stringify({ level: "error", message: "Invalid configuration", error }));
  }
  process.exit(1);
}

const loaded = await loadConfig({
  environment: process.env,
  readTextFile: (path) => readFile(path, { encoding: "utf8" }),
});
if (!loaded.ok) {
  exitWithErrors(loaded.errors);
}
const config = loaded.value;

const keys = await loadOrCreateKeys(config.dataDir);
if (!keys.ok) {
  exitWithErrors(keys.errors);
}

const provider = createProvider({ issuer: config.issuer, keys: keys.value });
await using server = await startServer({
  app: createApp({ issuer: config.issuer, provider }),
  host: config.host,
  port: config.port,
});
console.log(
  JSON.stringify({
    level: "info",
    message: "Listening",
    issuer: config.issuer,
    port: server.port,
    upstreamIssuer: config.upstream.issuer,
  }),
);

// Node does not stop on SIGTERM when it runs as PID 1 in a container, so wait
// for either signal explicitly and let `await using` close the server.
const signal = await Promise.race([
  once(process, "SIGTERM").then(() => "SIGTERM"),
  once(process, "SIGINT").then(() => "SIGINT"),
]);
console.log(JSON.stringify({ level: "info", message: "Shutting down", signal }));
