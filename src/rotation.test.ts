import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as client from "openid-client";

import { databaseFileName } from "./database.ts";
import { runKeyCommand } from "./key-command.ts";
import { publishWaitMs, signingKeyRetireWaitMs } from "./key-rotation.ts";
import { loadOrCreateKeys, type ProviderKeys } from "./keys.ts";
import {
  appLogin,
  exchangeAtBroker,
  formAction,
  type Harness,
  startHarness,
  testApp,
  visitUntilPage,
  visitUsingBrokerSession,
} from "./test-support/login-harness.ts";
import { checkSignature, decodeJwt, publishedKeys } from "./test-support/tokens.ts";

const root = mkdtempSync(join(tmpdir(), "solid-oidc-rotation-"));
after(() => rmSync(root, { force: true, recursive: true }));

describe("rotating keys", () => {
  it("keeps every token and session working through a planned rotation", async () => {
    const dataDir = join(root, "planned");
    const keys = new KeyDirectory(dataDir);
    await using harness = await startHarness({
      databasePath: join(dataDir, databaseFileName),
      keys: await keys.load(),
    });
    const { keyPair, tokens } = await logInWithConsent(harness);
    const [original] = await kidsPublished(harness);

    // Rotate: the new signing key is published, but doesn't sign yet.
    await keys.run("rotate");
    harness.restartBroker({ keys: await keys.load() });
    const [, added] = await kidsPublished(harness);
    assert.ok(added, "expected the new key to be published");
    assert.equal(kidOf((await logInAgain(harness)).access_token), original);
    assert.equal(await checkSignature(harness.issuer, tokens.access_token), "valid");

    // Promote: the new key signs, and the old one still verifies.
    keys.advance(publishWaitMs);
    await keys.run("promote");
    harness.restartBroker({ keys: await keys.load() });
    assert.deepEqual(await kidsPublished(harness), [added, original]);
    assert.equal(kidOf((await logInAgain(harness)).access_token), added);
    assert.equal(await checkSignature(harness.issuer, tokens.access_token), "valid");
    const refreshed = await refresh(harness, tokens, keyPair);
    assert.equal(kidOf(refreshed.access_token), added);

    // Retire: once its tokens have expired, the old key is unpublished.
    // Old cookie keys stay until sessions have expired too.
    keys.advance(signingKeyRetireWaitMs);
    await keys.run("retire");
    harness.restartBroker({ keys: await keys.load() });
    assert.deepEqual(await kidsPublished(harness), [added]);
    assert.equal(await checkSignature(harness.issuer, tokens.access_token), "unpublished key");
    assert.equal(kidOf((await logInAgain(harness)).access_token), added);
    assert.ok((await refresh(harness, refreshed, keyPair)).access_token);
  });

  it("signs cookies with the newest cookie key", async () => {
    const dataDir = join(root, "signing");
    const keys = new KeyDirectory(dataDir);
    await using harness = await startHarness({
      databasePath: join(dataDir, databaseFileName),
      keys: await keys.load(),
    });
    await keys.run("rotate");
    const rotated = await keys.load();
    harness.restartBroker({ keys: rotated });

    const login = await appLogin(harness);
    const response = await fetch(login.authorizationUrl, { redirect: "manual" });
    await response.body?.cancel();

    const cookies = new Map(
      response.headers.getSetCookie().map((line) => {
        const [pair = ""] = line.split(";");
        const separator = pair.indexOf("=");
        return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
      }),
    );
    const value = cookies.get("_interaction");
    assert.ok(value, `expected an interaction cookie, got ${[...cookies.keys()].join(", ")}`);
    const expected = createHmac("sha1", rotated.cookieKeys[0] ?? "")
      .update(`_interaction=${value}`)
      .digest("base64url");
    assert.equal(cookies.get("_interaction.sig"), expected);
  });

  it("keeps a session whose cookie was signed by an older cookie key", async () => {
    const dataDir = join(root, "cookies");
    const keys = new KeyDirectory(dataDir);
    await using harness = await startHarness({
      databasePath: join(dataDir, databaseFileName),
      keys: await keys.load(),
    });
    await logInWithConsent(harness);

    await keys.run("rotate");
    harness.restartBroker({ keys: await keys.load() });

    // The browser's cookies were signed with the old key, which now only
    // verifies. Reaching the app shows the session was found.
    assert.ok(await logInAgain(harness));
  });

  it("logs everyone out and invalidates every token when keys are revoked", async () => {
    const dataDir = join(root, "revoked");
    const keys = new KeyDirectory(dataDir);
    await using harness = await startHarness({
      databasePath: join(dataDir, databaseFileName),
      keys: await keys.load(),
    });
    const { keyPair, tokens } = await logInWithConsent(harness);
    const [leaked] = await kidsPublished(harness);

    await keys.run("revoke", "--confirm");
    harness.restartBroker({ keys: await keys.load() });

    const published = await kidsPublished(harness);
    assert.equal(published.length, 1);
    assert.ok(!published.includes(leaked ?? ""), "expected the leaked key to be unpublished");
    assert.equal(await checkSignature(harness.issuer, tokens.access_token), "unpublished key");
    await assert.rejects(refresh(harness, tokens, keyPair), (error: Error & { code?: string }) => {
      assert.equal(error.code, "OAUTH_RESPONSE_BODY_ERROR");
      return true;
    });
    // With its session gone, the broker sends the browser to the upstream
    // provider to log in again.
    const again = await appLogin(harness);
    const upstreamOrigin = new URL(harness.upstream.issuer).origin;
    const stopped = await visitUsingBrokerSession(harness, again.authorizationUrl);
    assert.equal(
      stopped.url.origin,
      upstreamOrigin,
      `expected a new upstream login, got ${stopped.url.href}`,
    );
  });
});

/** A data directory whose keys change through the key command. */
class KeyDirectory {
  readonly #dataDir: string;
  #now = Date.now();

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /** Move the key command's clock forward. */
  advance(ms: number): void {
    this.#now += ms;
  }

  async load(): Promise<ProviderKeys> {
    const loaded = await loadOrCreateKeys({ dataDir: this.#dataDir, now: () => this.#now });
    assert.ok(loaded.ok, `expected the keys to load: ${JSON.stringify(loaded)}`);
    return loaded.value;
  }

  async run(...args: string[]): Promise<void> {
    const errors: string[] = [];
    const code = await runKeyCommand({
      args,
      dataDir: this.#dataDir,
      now: () => this.#now,
      print: () => undefined,
      printError: (line) => errors.push(line),
    });
    assert.equal(code, 0, `expected ${args.join(" ")} to succeed: ${errors.join("\n")}`);
  }
}

async function kidsPublished(harness: Harness): Promise<string[]> {
  return (await publishedKeys(harness.issuer)).map((key) => key.kid);
}

function kidOf(jwt: string): unknown {
  return decodeJwt(jwt).header["kid"];
}

async function logInWithConsent(harness: Harness) {
  const login = await appLogin(harness, testApp, {
    prompt: "consent",
    scope: "openid offline_access",
  });
  const consent = await visitUntilPage(harness, login.authorizationUrl);
  const callback = await visitUntilPage(harness, formAction(consent, "Allow"), "POST");
  const result = await exchangeAtBroker(harness, login, callback.url);
  assert.ok(result.tokens.refresh_token, "expected a refresh token");
  return result;
}

// Log in again from the same browser. The broker's session should answer
// without asking the upstream provider.
async function logInAgain(harness: Harness): Promise<client.TokenEndpointResponse> {
  const login = await appLogin(harness);
  const returned = await visitUsingBrokerSession(harness, login.authorizationUrl);
  assert.ok(
    returned.url.searchParams.has("code"),
    `expected the broker's session to answer, got ${returned.status} ${returned.url.href}`,
  );
  return (await exchangeAtBroker(harness, login, returned.url)).tokens;
}

async function refresh(
  harness: Harness,
  tokens: client.TokenEndpointResponse,
  keyPair: client.CryptoKeyPair,
): Promise<client.TokenEndpointResponse> {
  const configuration = await client.discovery(
    new URL(harness.issuer),
    testApp.client_id,
    undefined,
    client.None(),
    { execute: [client.allowInsecureRequests] },
  );
  return client.refreshTokenGrant(configuration, tokens.refresh_token ?? "", undefined, {
    DPoP: client.getDPoPHandle(configuration, keyPair),
  });
}
