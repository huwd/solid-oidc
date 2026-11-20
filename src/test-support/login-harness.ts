import assert from "node:assert/strict";
import * as client from "openid-client";

import { type Account, createStaticAccountStore } from "../accounts.ts";
import { createApp, upstreamRedirectUri } from "../app.ts";
import { openDatabase, type ProviderDatabase } from "../database.ts";
import type { LogEntry } from "../interactions.ts";
import { generateProviderKeys } from "../keys.ts";
import { createPendingLogins } from "../pending-logins.ts";
import { createProvider } from "../provider.ts";
import { createUpstreamClient } from "../upstream.ts";
import { type Browser, createBrowser, type Visit } from "./browser.ts";
import { listenOnLoopback } from "./loopback.ts";
import { startUpstreamProvider, type UpstreamProvider } from "./upstream-provider.ts";

/**
 * End-to-end login harness: a Solid app's browser, the broker and a stand-in
 * upstream provider, each a real OpenID implementation on loopback.
 */

const keys = generateProviderKeys();
export const appOrigin = "https://app.example.test";
export const aliceSubject = "8c1f6d2e-0000-4000-8000-a11ce0000000";
export const aliceWebId = "https://alice.example.test/profile/card#me";

export const testApp = {
  client_id: "test-app",
  client_name: "Test <App>",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [`${appOrigin}/callback`],
  token_endpoint_auth_method: "none",
} as const;
export const unnamedApp = {
  client_id: "unnamed-app",
  redirect_uris: [`${appOrigin}/unnamed`],
  token_endpoint_auth_method: "none",
} as const;

export type Harness = AsyncDisposable & {
  readonly browser: Browser;
  readonly issuer: string;
  readonly logs: LogEntry[];
  /**
   * Replace the broker with a new one on the same origin, as a restart does:
   * nothing survives but the database file and the keys.
   */
  restartBroker(): void;
  readonly upstream: UpstreamProvider;
};

export async function startHarness(
  options: {
    readonly accounts?: (upstreamIssuer: string) => readonly Account[];
    /** A database file to keep across restarts. By default, one in memory. */
    readonly databasePath?: string;
    /** Serves Client ID Documents. By default, every fetch fails. */
    readonly fetch?: typeof globalThis.fetch;
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
  let database: ProviderDatabase | undefined;

  function startBroker(): void {
    database?.[Symbol.dispose]();
    const opened = openDatabase({ now: Date.now, path: options.databasePath ?? ":memory:" });
    assert.ok(opened.ok, `expected the database to open: ${JSON.stringify(opened)}`);
    database = opened.value;
    const app = createApp({
      accounts,
      issuer,
      log: (entry) => logs.push(entry),
      pendingLogins: createPendingLogins({ entriesMax: 100, now: Date.now, ttlMs: 60_000 }),
      provider: createProvider({
        accounts,
        adapter: database.adapter,
        allowLoopbackClientIds: false,
        clients: [testApp, unnamedApp],
        fetch: options.fetch ?? refuseFetch,
        issuer,
        keys,
        upstreamIssuer: upstream.issuer,
      }),
      upstream: createUpstreamClient({
        clientId: upstream.clientId,
        clientSecret: upstream.clientSecret,
        issuer: options.upstreamIssuer ?? upstream.issuer,
        redirectUri: upstreamRedirectUri(issuer),
      }),
    });
    brokerServer.serve(app.callback());
  }
  startBroker();

  return {
    browser: createBrowser(),
    issuer,
    logs,
    restartBroker: startBroker,
    upstream,
    async [Symbol.asyncDispose]() {
      await upstream[Symbol.asyncDispose]();
      await brokerServer[Symbol.asyncDispose]();
      database?.[Symbol.dispose]();
    },
  };
}

/** A fetch for tests that must not reach the network. */
export const refuseFetch: typeof globalThis.fetch = (input) =>
  Promise.reject(new Error(`no network in tests: ${String(input)}`));

export function alice(upstreamIssuer: string): Account {
  return { upstreamIssuer, upstreamSubject: aliceSubject, webId: aliceWebId };
}

/** What a Solid app keeps while its user logs in. */
export type AppLogin = {
  readonly authorizationUrl: URL;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly state: string;
};

export async function appLogin(
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

export const toApp = (location: URL): boolean => location.origin === appOrigin;

/** Follow the login until the broker shows a page or returns to the app. */
export function visitUntilPage(
  harness: Harness,
  url: URL | string,
  method?: "POST",
): Promise<Visit> {
  return harness.browser.visit(url, { method, stopAt: toApp });
}

/**
 * Follow a login that the broker's own session should answer, stopping if it
 * returns to the app or goes to the upstream provider. The stand-in upstream
 * keeps its own session, so a lost broker session would otherwise be hidden
 * by the upstream logging the same person straight back in.
 */
export function visitUsingBrokerSession(harness: Harness, url: URL | string): Promise<Visit> {
  const upstreamOrigin = new URL(harness.upstream.issuer).origin;
  return harness.browser.visit(url, {
    stopAt: (location) => toApp(location) || location.origin === upstreamOrigin,
  });
}

export function formAction(page: Visit, button: "Allow" | "Deny"): URL {
  const forms = [
    ...page.body.matchAll(/<form method="post" action="([^"]+)"><button type="submit">(\w+)/g),
  ];
  const action = forms.find((form) => form[2] === button)?.[1];
  assert.ok(action, `expected a ${button} button on the page:\n${page.body}`);
  return new URL(action, page.url);
}

/**
 * Exchange the code as a Solid app does, with a DPoP proof from a fresh key.
 * Returns the tokens and the key, whose thumbprint the access token must name.
 */
export async function exchangeAtBroker(
  harness: Harness,
  login: AppLogin,
  callback: URL,
  options: { readonly clientId?: string; readonly dpop?: boolean } = {},
) {
  const configuration = await client.discovery(
    new URL(harness.issuer),
    options.clientId ?? testApp.client_id,
    undefined,
    client.None(),
    { execute: [client.allowInsecureRequests] },
  );
  const keyPair = await client.randomDPoPKeyPair("ES256");
  const tokens = await client.authorizationCodeGrant(
    configuration,
    callback,
    {
      expectedNonce: login.nonce,
      expectedState: login.state,
      pkceCodeVerifier: login.codeVerifier,
    },
    undefined,
    options.dpop === false ? {} : { DPoP: client.getDPoPHandle(configuration, keyPair) },
  );
  return { keyPair, tokens };
}
