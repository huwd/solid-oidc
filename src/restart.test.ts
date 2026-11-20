import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as client from "openid-client";

import {
  appLogin,
  exchangeAtBroker,
  formAction,
  startHarness,
  testApp,
  visitUntilPage,
  visitUsingBrokerSession,
} from "./test-support/login-harness.ts";

const root = mkdtempSync(join(tmpdir(), "solid-oidc-restart-"));
after(() => rmSync(root, { force: true, recursive: true }));

describe("restarting the broker", () => {
  it("keeps sessions and refresh tokens issued before the restart", async () => {
    await using harness = await startHarness({ databasePath: join(root, "provider.sqlite") });
    const login = await appLogin(harness, testApp, {
      prompt: "consent",
      scope: "openid offline_access",
    });
    const consent = await visitUntilPage(harness, login.authorizationUrl);
    const callback = await visitUntilPage(harness, formAction(consent, "Allow"), "POST");
    const { keyPair, tokens } = await exchangeAtBroker(harness, login, callback.url);
    assert.ok(tokens.refresh_token, "expected a refresh token");

    harness.restartBroker();

    // The refresh token is DPoP-bound, so it needs the same key.
    const configuration = await client.discovery(
      new URL(harness.issuer),
      testApp.client_id,
      undefined,
      client.None(),
      {
        execute: [client.allowInsecureRequests],
      },
    );
    const refreshed = await client.refreshTokenGrant(
      configuration,
      tokens.refresh_token,
      undefined,
      {
        DPoP: client.getDPoPHandle(configuration, keyPair),
      },
    );
    assert.ok(refreshed.access_token, "expected the refresh token to work after the restart");

    // If the session were lost, the broker would send the browser to the
    // upstream provider again.
    const again = await appLogin(harness);
    const returned = await visitUsingBrokerSession(harness, again.authorizationUrl);
    assert.ok(
      returned.url.searchParams.has("code"),
      `expected the session to survive, got ${returned.status} ${returned.url.href}`,
    );
  });
});
