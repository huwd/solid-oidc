// Starts the sandbox's stubs: the upstream provider, the Solid app and the
// app's Client ID Document. See the Sandbox section of the README.

import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { createStubApp } from "./app.ts";
import { ports, readSettings, urls } from "./settings.ts";
import { createUpstream } from "./upstream.ts";

const certificates = process.env["SANDBOX_CERTS_DIR"] ?? "/certs";
const settings = readSettings(process.env);
const { app, clientDocument } = createStubApp(settings);

createHttpServer(createUpstream(settings).callback()).listen(ports.upstream, "0.0.0.0");
createHttpServer(app.callback()).listen(ports.app, "0.0.0.0");
createHttpsServer(
  {
    cert: readFileSync(`${certificates}/cert.pem`),
    key: readFileSync(`${certificates}/key.pem`),
  },
  clientDocument.callback(),
).listen(ports.clientDocument, "0.0.0.0");

console.log(
  JSON.stringify({
    app: urls.app,
    broker: urls.broker,
    clientDocument: urls.clientDocument,
    message: "Sandbox stubs listening. Open the app in a browser.",
    upstream: urls.upstream,
  }),
);

// Node does not stop on SIGTERM when it runs as PID 1 in a container.
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
