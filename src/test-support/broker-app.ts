import type Koa from "koa";

import { createStaticAccountStore } from "../accounts.ts";
import { createApp } from "../app.ts";
import { openDatabase } from "../database.ts";
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
    provider: createProvider({
      accounts,
      adapter: inMemoryDatabase().adapter,
      clients: [],
      fetch: () => Promise.reject(new Error("no network in tests")),
      issuer,
      keys,
      upstreamIssuer: "https://auth.example.test",
    }),
    upstream: unreachableUpstream,
  });
}

/** A fresh SQLite database in memory, so tests use the same adapter as production. */
export function inMemoryDatabase() {
  const opened = openDatabase({ now: Date.now, path: ":memory:" });
  if (!opened.ok) {
    throw new Error(opened.errors.join("; "));
  }
  return opened.value;
}

/** The signing keys every app from createTestBrokerApp uses. */
export const testBrokerKeys = keys;
