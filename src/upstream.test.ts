import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listenOnLoopback } from "./test-support/loopback.ts";
import { createUpstreamClient, newLoginChecks } from "./upstream.ts";

// The login tests run the full flow against a real upstream provider. These
// cover discovery failing, over HTTPS and over plain HTTP on loopback.
async function closedPort(): Promise<number> {
  const server = await listenOnLoopback();
  await server[Symbol.asyncDispose]();
  return Number(new URL(server.origin).port);
}

describe("createUpstreamClient", () => {
  it("reports an upstream provider that can't be reached over HTTPS", async () => {
    const upstream = createUpstreamClient({
      clientId: "broker",
      clientSecret: "secret",
      issuer: `https://127.0.0.1:${await closedPort()}`,
      redirectUri: "https://id.example.test/upstream/callback",
    });

    const result = await upstream.authorizationUrl(newLoginChecks());

    assert.ok(!result.ok, "expected discovery to fail");
    assert.match(result.errors[0] ?? "", /^upstream discovery failed \(/);
  });

  it("tries discovery again after it fails", async () => {
    const port = await closedPort();
    const upstream = createUpstreamClient({
      clientId: "broker",
      clientSecret: "secret",
      issuer: `http://127.0.0.1:${port}`,
      redirectUri: "https://id.example.test/upstream/callback",
    });
    const first = await upstream.authorizationUrl(newLoginChecks());
    assert.ok(!first.ok, "expected the first discovery to fail");

    const identified = await upstream.identify({
      callbackUrl: new URL("https://id.example.test/upstream/callback?code=x&state=y"),
      checks: newLoginChecks(),
    });

    assert.ok(!identified.ok, "expected the retried discovery to fail too");
    assert.match(identified.errors[0] ?? "", /^upstream login failed \(/);
  });
});
