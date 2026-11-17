// Process entry point: reads the environment, starts the server and handles
// signals and exit codes. It cannot run under the test runner without
// replacing process globals, so the test script excludes src/bin/ from
// coverage. Keep logic out of this file; the functions it calls are tested.

import { once } from "node:events";

import { createApp } from "../app.ts";
import { parseConfig } from "../config.ts";
import { startServer } from "../server.ts";

const result = parseConfig(process.env);
if (!result.ok) {
  for (const error of result.errors) {
    console.error(JSON.stringify({ level: "error", message: "Invalid configuration", error }));
  }
  process.exit(1);
}

const { config } = result;
await using server = await startServer({
  app: createApp(),
  host: config.host,
  port: config.port,
});
console.log(
  JSON.stringify({
    level: "info",
    message: "Listening",
    issuer: config.issuer,
    port: server.port,
  }),
);

// Node does not stop on SIGTERM when it runs as PID 1 in a container, so wait
// for either signal explicitly and let `await using` close the server.
const signal = await Promise.race([
  once(process, "SIGTERM").then(() => "SIGTERM"),
  once(process, "SIGINT").then(() => "SIGINT"),
]);
console.log(JSON.stringify({ level: "info", message: "Shutting down", signal }));
