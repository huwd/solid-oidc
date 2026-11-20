import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Koa from "koa";
import type Provider from "oidc-provider";

import { createStaticAccountStore } from "./accounts.ts";
import { interactionRoutes } from "./interactions.ts";
import { createPendingLogins } from "./pending-logins.ts";
import { startServer } from "./server.ts";
import { unreachableUpstream } from "./test-support/broker-app.ts";

// The login tests cover these routes against real providers. This covers
// what they can't: an unexpected error from the provider itself.
describe("interactionRoutes", () => {
  it("lets an unexpected provider error through, rather than calling it an expired login", async () => {
    const failing = {
      interactionDetails: () => Promise.reject(new Error("storage is down")),
    } as unknown as Provider;
    const app = new Koa();
    app.silent = true;
    app.use(
      interactionRoutes({
        accounts: createStaticAccountStore([]),
        log: () => undefined,
        pendingLogins: createPendingLogins({ entriesMax: 1, now: Date.now, ttlMs: 1 }),
        prefix: "",
        provider: failing,
        upstream: unreachableUpstream,
        upstreamRedirectUri: "https://id.example.test/upstream/callback",
      }),
    );
    await using server = await startServer({ app, host: "127.0.0.1", port: 0 });

    const response = await fetch(`http://127.0.0.1:${server.port}/interaction/abc`);
    await response.body?.cancel();

    assert.equal(response.status, 500);
  });
});
