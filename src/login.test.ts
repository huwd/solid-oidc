import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as client from "openid-client";

import { type Account, createStaticAccountStore } from "./accounts.ts";
import { createApp, upstreamRedirectUri } from "./app.ts";
import type { LogEntry } from "./interactions.ts";
import { generateProviderKeys } from "./keys.ts";
import { createPendingLogins } from "./pending-logins.ts";
import { createProvider } from "./provider.ts";
import { type Browser, createBrowser, type Visit } from "./test-support/browser.ts";
import { listenOnLoopback } from "./test-support/loopback.ts";
import { startUpstreamProvider, type UpstreamProvider } from "./test-support/upstream-provider.ts";
import { createUpstreamClient } from "./upstream.ts";

// End-to-end login tests: a Solid app's browser, the broker and a stand-in
// upstream provider, each a real OpenID implementation on loopback.

const keys = generateProviderKeys();
const appOrigin = "https://app.example.test";
const aliceSubject = "8c1f6d2e-0000-4000-8000-a11ce0000000";
const aliceWebId = "https://alice.example.test/profile/card#me";

const testApp = {
  client_id: "test-app",
  client_name: "Test <App>",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [`${appOrigin}/callback`],
  token_endpoint_auth_method: "none",
} as const;
const unnamedApp = {
  client_id: "unnamed-app",
  redirect_uris: [`${appOrigin}/unnamed`],
  token_endpoint_auth_method: "none",
} as const;

type Harness = AsyncDisposable & {
  readonly browser: Browser;
  readonly issuer: string;
  readonly logs: LogEntry[];
  readonly upstream: UpstreamProvider;
};

async function startHarness(
  options: {
    readonly accounts?: (upstreamIssuer: string) => readonly Account[];
    /** Point the broker at this upstream issuer instead of the stand-in. */
    readonly upstreamIssuer?: string;
  } = {},
): Promise<Harness> {
  const brokerServer = await listenOnLoopback();
  const issuer = `${brokerServer.origin}/solid`;
  const upstream = await startUpstreamProvider({ redirectUri: upstreamRedirectUri(issuer) });
  upstream.logInAs(aliceSubject);

  const mapping = options.accounts ?? ((upstreamIssuer) => [alice(upstreamIssuer)]);
  const accounts = createStaticAccountStore(mapping(upstream.issuer));
  const logs: LogEntry[] = [];
  const app = createApp({
    accounts,
    issuer,
    log: (entry) => logs.push(entry),
    pendingLogins: createPendingLogins({ entriesMax: 100, now: Date.now, ttlMs: 60_000 }),
    provider: createProvider({ accounts, clients: [testApp, unnamedApp], issuer, keys }),
    upstream: createUpstreamClient({
      clientId: upstream.clientId,
      clientSecret: upstream.clientSecret,
      issuer: options.upstreamIssuer ?? upstream.issuer,
      redirectUri: upstreamRedirectUri(issuer),
    }),
  });
  brokerServer.serve(app.callback());

  return {
    browser: createBrowser(),
    issuer,
    logs,
    upstream,
    async [Symbol.asyncDispose]() {
      await upstream[Symbol.asyncDispose]();
      await brokerServer[Symbol.asyncDispose]();
    },
  };
}

function alice(upstreamIssuer: string): Account {
  return { upstreamIssuer, upstreamSubject: aliceSubject, webId: aliceWebId };
}

/** What a Solid app keeps while its user logs in. */
type AppLogin = {
  readonly authorizationUrl: URL;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly state: string;
};

async function appLogin(
  harness: Harness,
  app: { readonly client_id: string; readonly redirect_uris: readonly string[] } = testApp,
  extra: Record<string, string> = {},
): Promise<AppLogin> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const nonce = client.randomNonce();
  const state = client.randomState();
  const authorizationUrl = new URL(`${harness.issuer}/auth`);
  authorizationUrl.search = new URLSearchParams({
    client_id: app.client_id,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    nonce,
    redirect_uri: app.redirect_uris[0] ?? "",
    response_type: "code",
    scope: "openid",
    state,
    ...extra,
  }).toString();
  return { authorizationUrl, codeVerifier, nonce, state };
}

const toApp = (location: URL): boolean => location.origin === appOrigin;

/** Follow the login until the broker shows a page or returns to the app. */
function visitUntilPage(harness: Harness, url: URL | string, method?: "POST"): Promise<Visit> {
  return harness.browser.visit(url, { method, stopAt: toApp });
}

function formAction(page: Visit, button: "Allow" | "Deny"): URL {
  const forms = [
    ...page.body.matchAll(/<form method="post" action="([^"]+)"><button type="submit">(\w+)/g),
  ];
  const action = forms.find((form) => form[2] === button)?.[1];
  assert.ok(action, `expected a ${button} button on the page:\n${page.body}`);
  return new URL(action, page.url);
}

async function exchangeAtBroker(harness: Harness, login: AppLogin, callback: URL) {
  const configuration = await client.discovery(
    new URL(harness.issuer),
    testApp.client_id,
    undefined,
    client.None(),
    { execute: [client.allowInsecureRequests] },
  );
  return client.authorizationCodeGrant(configuration, callback, {
    expectedNonce: login.nonce,
    expectedState: login.state,
    pkceCodeVerifier: login.codeVerifier,
  });
}

describe("logging in through the upstream provider", () => {
  it("ends with an ID token for the mapped WebID", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const consent = await visitUntilPage(harness, login.authorizationUrl);
    const callback = await visitUntilPage(harness, formAction(consent, "Allow"), "POST");
    const tokens = await exchangeAtBroker(harness, login, callback.url);

    const claims = tokens.claims();
    assert.equal(claims?.sub, aliceWebId);
    assert.equal(claims?.iss, harness.issuer);
    assert.equal(claims?.["email"], undefined, "expected no upstream claims to pass through");
  });

  it("asks for consent naming the app and the WebID", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const consent = await visitUntilPage(harness, login.authorizationUrl);

    assert.equal(consent.status, 200);
    assert.match(consent.body, /Test &lt;App&gt; \(<code>test-app<\/code>\)/);
    assert.ok(
      consent.body.includes(`<code>${aliceWebId}</code>`),
      "expected the WebID on the page",
    );
  });

  it("asks again before another app can use an existing session", async () => {
    await using harness = await startHarness();
    const first = await appLogin(harness);
    const consent = await visitUntilPage(harness, first.authorizationUrl);
    await visitUntilPage(harness, formAction(consent, "Allow"), "POST");

    const second = await appLogin(harness, unnamedApp);
    const page = await visitUntilPage(harness, second.authorizationUrl);

    assert.equal(page.status, 200);
    assert.match(page.body, /<code>unnamed-app<\/code> wants to act as/);
  });

  it("asks again when the same app wants more than it was granted", async () => {
    await using harness = await startHarness();
    const first = await appLogin(harness);
    const consent = await visitUntilPage(harness, first.authorizationUrl);
    await visitUntilPage(harness, formAction(consent, "Allow"), "POST");

    const wider = await appLogin(harness, testApp, {
      prompt: "consent",
      scope: "openid offline_access",
    });
    const page = await visitUntilPage(harness, wider.authorizationUrl);
    const callback = await visitUntilPage(harness, formAction(page, "Allow"), "POST");

    assert.equal(callback.url.origin, appOrigin);
    assert.ok(callback.url.searchParams.has("code"), `expected a code, got ${callback.url.href}`);
  });

  it("returns access_denied to the app when the person denies it", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const consent = await visitUntilPage(harness, login.authorizationUrl);

    const callback = await visitUntilPage(harness, formAction(consent, "Deny"), "POST");

    assert.equal(callback.url.searchParams.get("error"), "access_denied");
  });
});

describe("refusing a login", () => {
  async function assertRefused(harness: Harness, visit: Visit) {
    assert.equal(visit.status, 403, `expected a refusal, got ${visit.status}`);
    assert.match(visit.body, /You could not be logged in/);
    assert.ok(!visit.body.includes(aliceSubject), "the page must not reveal the subject");
    assert.ok(!visit.body.includes("webid") && !visit.body.includes("WebID"));
    return harness.logs;
  }

  it("refuses an upstream subject with no mapping", async () => {
    await using harness = await startHarness();
    harness.upstream.logInAs("ffffffff-0000-4000-8000-000000000bad");
    const login = await appLogin(harness);

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    const logs = await assertRefused(harness, visit);
    assert.deepEqual(logs.at(-1), {
      level: "info",
      message: "No account for upstream identity",
      upstreamIssuer: harness.upstream.issuer,
      upstreamSubject: "ffffffff-0000-4000-8000-000000000bad",
    });
  });

  it("refuses a known subject from another issuer", async () => {
    await using harness = await startHarness({
      accounts: () => [alice("https://other-upstream.example.test")],
    });
    const login = await appLogin(harness);

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    await assertRefused(harness, visit);
  });

  it("refuses a callback whose state was changed", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const visit = await harness.browser.visit(login.authorizationUrl, {
      rewrite: (location) => {
        const state = location.searchParams.get("state");
        if (location.pathname.endsWith("/upstream/callback") && state !== null) {
          location.searchParams.set("state", `${state}-tampered`);
        }
        return location;
      },
      stopAt: toApp,
    });

    const logs = await assertRefused(harness, visit);
    assert.match(logs.at(-1)?.["error"] ?? "", /state/i);
  });

  it("refuses an ID token whose nonce doesn't match the login", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const visit = await harness.browser.visit(login.authorizationUrl, {
      rewrite: (location) => {
        if (location.origin === harness.upstream.issuer && location.searchParams.has("nonce")) {
          location.searchParams.set("nonce", "not-the-nonce-the-broker-sent");
        }
        return location;
      },
      stopAt: toApp,
    });

    const logs = await assertRefused(harness, visit);
    assert.match(logs.at(-1)?.["error"] ?? "", /OAUTH_JWT_CLAIM_COMPARISON_FAILED/);
  });

  it("refuses an error from the upstream provider", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const toUpstream = await harness.browser.visit(login.authorizationUrl, {
      stopAt: (location) => location.origin === harness.upstream.issuer,
    });
    const state = toUpstream.url.searchParams.get("state") ?? "";

    const callback = new URL(upstreamRedirectUri(harness.issuer));
    callback.search = new URLSearchParams({
      error: "access_denied",
      iss: harness.upstream.issuer,
      state,
    }).toString();
    const visit = await visitUntilPage(harness, callback);

    const logs = await assertRefused(harness, visit);
    assert.match(logs.at(-1)?.["error"] ?? "", /access_denied/);
  });

  it("refuses a callback with no usable state", async () => {
    await using harness = await startHarness();

    const visit = await visitUntilPage(harness, `${upstreamRedirectUri(harness.issuer)}?code=x`);

    await assertRefused(harness, visit);
  });
});

describe("binding each login to its browser", () => {
  async function captureCallback(harness: Harness): Promise<URL> {
    const login = await appLogin(harness);
    const visit = await harness.browser.visit(login.authorizationUrl, {
      stopAt: (location) => location.pathname.endsWith("/upstream/callback"),
    });
    return visit.url;
  }

  it("won't finish a login in a browser that didn't start it", async () => {
    await using harness = await startHarness();
    const callback = await captureCallback(harness);

    const visit = await createBrowser().visit(callback, { stopAt: toApp });

    assert.equal(visit.status, 400);
    assert.match(visit.body, /This login has expired/);
  });

  it("won't use the same callback twice", async () => {
    await using harness = await startHarness();
    const callback = await captureCallback(harness);
    await visitUntilPage(harness, callback);

    const replay = await visitUntilPage(harness, callback);

    assert.equal(replay.status, 400);
  });

  it("won't resume a login that has no pending upstream request", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const toUpstream = await harness.browser.visit(login.authorizationUrl, {
      stopAt: (location) => location.origin === harness.upstream.issuer,
    });
    const uid = toUpstream.url.searchParams.get("state")?.split(".")[0] ?? "";

    // Asking for the interaction again starts a fresh upstream request, and a
    // callback is accepted at most once, so a stale one finds nothing.
    const resume = `${harness.issuer}/interaction/${uid}/upstream?code=stale&state=${uid}.stale`;
    await visitUntilPage(harness, resume);
    const visit = await visitUntilPage(harness, resume);

    assert.equal(visit.status, 400);
    assert.match(visit.body, /This login has expired/);
  });

  it("won't act on an interaction the browser's cookie doesn't name", async () => {
    await using harness = await startHarness();
    await captureCallback(harness);

    const visit = await visitUntilPage(harness, `${harness.issuer}/interaction/someone-elses-uid`);

    assert.equal(visit.status, 400);
    assert.match(visit.body, /This login has expired/);
  });

  it("refuses a step that doesn't fit the interaction", async () => {
    await using harness = await startHarness();
    const callback = await captureCallback(harness);
    const uid = callback.searchParams.get("state")?.split(".")[0] ?? "";

    const visit = await visitUntilPage(
      harness,
      `${harness.issuer}/interaction/${uid}/confirm`,
      "POST",
    );

    assert.equal(visit.status, 400);
    assert.match(visit.body, /This page is not available/);
  });
});

describe("an unavailable upstream provider", () => {
  it("shows that login is unavailable", async () => {
    const closed = await listenOnLoopback();
    const unreachable = closed.origin;
    await closed[Symbol.asyncDispose]();
    await using harness = await startHarness({ upstreamIssuer: unreachable });
    const login = await appLogin(harness);

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    assert.equal(visit.status, 502);
    assert.match(visit.body, /Login is not available/);
    assert.equal(harness.logs.at(-1)?.message, "Upstream unavailable");
  });
});
