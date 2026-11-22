import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Koa from "koa";
import type Provider from "oidc-provider";

import { createStaticAccountStore } from "./accounts.ts";
import { interactionRoutes } from "./interactions.ts";
import { createPendingLogins } from "./pending-logins.ts";
import { startServer } from "./server.ts";
import { unreachableUpstream } from "./test-support/broker-app.ts";
import { newLoginChecks, type UpstreamClient } from "./upstream.ts";

// The login tests cover these routes against real providers. These cover
// what they can't: an unexpected error from the provider itself, and an
// upstream client reporting more than one error.
describe("interactionRoutes", () => {
  for (const [step, path] of [
    ["starting", "/interaction/abc"],
    ["finishing", "/interaction/abc/upstream"],
  ] as const) {
    it(`logs every upstream error when ${step} an upstream login fails`, async () => {
      const failingUpstream: UpstreamClient = {
        authorizationUrl: () => Promise.resolve({ errors: ["first", "second"], ok: false }),
        identify: () => Promise.resolve({ errors: ["first", "second"], ok: false }),
      };
      const atLogin = {
        interactionDetails: () =>
          Promise.resolve({ params: {}, prompt: { name: "login" }, uid: "abc" }),
      } as unknown as Provider;
      const pendingLogins = createPendingLogins({ entriesMax: 1, now: Date.now, ttlMs: 60_000 });
      pendingLogins.put("abc", newLoginChecks());
      const logs: Record<string, unknown>[] = [];
      const app = new Koa();
      app.use(
        interactionRoutes({
          accounts: createStaticAccountStore([]),
          log: (entry) => logs.push(entry),
          pendingLogins,
          prefix: "",
          provider: atLogin,
          upstream: failingUpstream,
          upstreamRedirectUri: "https://id.example.test/upstream/callback",
        }),
      );
      await using server = await startServer({ app, host: "127.0.0.1", port: 0 });

      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      await response.body?.cancel();

      assert.equal(logs.at(-1)?.["error"], "first; second");
    });
  }

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
