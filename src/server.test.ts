import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { healthPath } from "./app.ts";
import { checkHealth } from "./healthcheck.ts";
import { startServer } from "./server.ts";
import { createTestBrokerApp } from "./test-support/broker-app.ts";

const timeoutMs = 2_000;

function createApp() {
  return createTestBrokerApp("https://id.example.test");
}

describe("server", () => {
  it("answers the health endpoint with ok", async () => {
    await using server = await startServer({ app: createApp(), host: "127.0.0.1", port: 0 });

    const response = await fetch(`http://127.0.0.1:${server.port}${healthPath}`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("returns 404 for an unknown path", async () => {
    await using server = await startServer({ app: createApp(), host: "127.0.0.1", port: 0 });

    const response = await fetch(`http://127.0.0.1:${server.port}/unknown`);
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });

  it("does not answer health checks with methods other than GET", async () => {
    await using server = await startServer({ app: createApp(), host: "127.0.0.1", port: 0 });

    const response = await fetch(`http://127.0.0.1:${server.port}${healthPath}`, {
      method: "POST",
    });
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });

  it("stops listening when disposed", async () => {
    const server = await startServer({ app: createApp(), host: "127.0.0.1", port: 0 });
    const url = new URL(`http://127.0.0.1:${server.port}${healthPath}`);

    await server[Symbol.asyncDispose]();

    assert.equal(await checkHealth({ timeoutMs, url }), false);
  });
});

describe("checkHealth", () => {
  it("reports a running server as healthy", async () => {
    await using server = await startServer({ app: createApp(), host: "127.0.0.1", port: 0 });
    const url = new URL(`http://127.0.0.1:${server.port}${healthPath}`);

    assert.equal(await checkHealth({ timeoutMs, url }), true);
  });

  it("reports an error status as unhealthy", async () => {
    await using server = await startServer({ app: createApp(), host: "127.0.0.1", port: 0 });
    const url = new URL(`http://127.0.0.1:${server.port}/missing`);

    assert.equal(await checkHealth({ timeoutMs, url }), false);
  });
});
