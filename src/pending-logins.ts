import type { LoginChecks } from "./upstream.ts";

/**
 * Logins waiting for the upstream provider to answer, by interaction ID.
 * Each is taken at most once, so a callback can't be replayed.
 */
export type PendingLogins = {
  put(uid: string, checks: LoginChecks): void;
  /** Remove and return the login for this interaction, if it hasn't expired. */
  take(uid: string): LoginChecks | undefined;
};

export type CreatePendingLoginsOptions = {
  /** The most logins to hold. Starting one more drops the oldest. */
  readonly entriesMax: number;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** How long a login may wait for the upstream provider. */
  readonly ttlMs: number;
};

type Entry = { readonly checks: LoginChecks; readonly expiresAt: number };

/**
 * Hold pending logins in memory. Anyone can start a login, so the store is
 * bounded: a flood of abandoned logins drops the oldest rather than growing
 * without limit. A restart loses pending logins, and the person starts again.
 */
export function createPendingLogins(options: CreatePendingLoginsOptions): PendingLogins {
  // A Map iterates in insertion order, so its first key is the oldest login.
  const entries = new Map<string, Entry>();

  function removeExpired(now: number): void {
    for (const [uid, entry] of entries) {
      if (entry.expiresAt > now) {
        return;
      }
      entries.delete(uid);
    }
  }

  return {
    put(uid, checks) {
      const now = options.now();
      removeExpired(now);
      entries.delete(uid);
      if (entries.size >= options.entriesMax) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
      entries.set(uid, { checks, expiresAt: now + options.ttlMs });
    },

    take(uid) {
      const entry = entries.get(uid);
      entries.delete(uid);
      if (entry === undefined || entry.expiresAt <= options.now()) {
        return undefined;
      }
      return entry.checks;
    },
  };
}
