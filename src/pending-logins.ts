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
  // Every login waits as long as the others, so the oldest also expires
  // first, and dropping it when full is all the clearing the store needs.
  const entries = new Map<string, Entry>();

  return {
    put(uid, checks) {
      // Starting again moves the login to the back, as the newest.
      entries.delete(uid);
      if (entries.size >= options.entriesMax) {
        for (const oldest of entries.keys()) {
          entries.delete(oldest);
          break;
        }
      }
      entries.set(uid, { checks, expiresAt: options.now() + options.ttlMs });
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
