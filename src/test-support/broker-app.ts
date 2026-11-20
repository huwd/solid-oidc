import type Koa from "koa";

import { createStaticAccountStore } from "../accounts.ts";
import { createApp } from "../app.ts";
import { generateProviderKeys } from "../keys.ts";
import { createPendingLogins } from "../pending-logins.ts";
import { createProvider } from "../provider.ts";
import type { UpstreamClient } from "../upstream.ts";

const keys = generateProviderKeys();

/** An upstream client for tests that never reach the upstream provider. */
export const unreachableUpstream: UpstreamClient = {
  authorizationUrl: () => Promise.resolve({ errors: ["not used in this test"], ok: false }),
  identify: () => Promise.resolve({ errors: ["not used in this test"], ok: false }),
};

/**
 * The broker's app with no clients, one account and an upstream provider it
 * never calls. For tests of discovery, keys and routing.
 */
export function createTestBrokerApp(issuer: string): Koa {
  const accounts = createStaticAccountStore([
    {
      upstreamIssuer: "https://auth.example.test",
      upstreamSubject: "subject",
      webId: "https://alice.example.test/profile/card#me",
    },
  ]);
  return createApp({
    accounts,
    issuer,
    log: () => undefined,
    pendingLogins: createPendingLogins({ entriesMax: 10, now: Date.now, ttlMs: 60_000 }),
    provider: createProvider({ accounts, clients: [], issuer, keys }),
    upstream: unreachableUpstream,
  });
}

/** The signing keys every app from createTestBrokerApp uses. */
export const testBrokerKeys = keys;
