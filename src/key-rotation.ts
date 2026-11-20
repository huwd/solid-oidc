import {
  type CookieKeyEntry,
  generateSigningKey,
  type KeyFile,
  keysMax,
  newCookieKey,
  newKeyFile,
  type SigningKeyEntry,
} from "./keys.ts";
import { sessionLifetimeSeconds, tokenLifetimeSeconds } from "./lifetimes.ts";
import type { Result } from "./validation.ts";

/**
 * Key rotation, as changes to the key file. Each step is a pure function of
 * the file and the time, and the broker uses the result after a restart.
 * See docs/decisions/0011-key-rotation.md.
 */

/**
 * How long a new signing key is published before it signs. Solid servers
 * cache the broker's key set: the Community Solid Server for 2 minutes, and
 * other verifiers built on `jose` for up to 10.
 */
export const publishWaitMs = 10 * 60_000;

/**
 * How long an old signing key stays published after a newer one starts
 * signing: the token lifetime, plus 5 minutes for the clock tolerance Solid
 * servers allow. The Community Solid Server allows 2 minutes.
 */
export const signingKeyRetireWaitMs = (tokenLifetimeSeconds + 5 * 60) * 1000;

/**
 * How long an old cookie key is kept after a newer one is added: a session
 * cookie lasts as long as its session. A cookie read while it is still valid
 * is signed again with the newest key.
 */
export const cookieKeyRetireWaitMs = sessionLifetimeSeconds * 1000;

export type StepOptions = {
  /** Milliseconds since the epoch. */
  readonly now: number;
  /**
   * Skip the wait, for a key that must go now. Tokens or sessions it still
   * protects stop working.
   */
  readonly skipWait?: boolean;
};

/** A changed key file, and what changed, one line each. */
export type StepResult = Result<{ readonly file: KeyFile; readonly changes: readonly string[] }>;

/**
 * Publish a new signing key without signing with it yet, and start signing
 * cookies with a new cookie key. Old keys stay, so nothing is invalidated.
 */
export function rotate(file: KeyFile, options: Pick<StepOptions, "now">): StepResult {
  const errors: string[] = [];
  if (pendingKey(file) !== undefined) {
    errors.push("A new signing key is already waiting to start signing. Promote it first.");
  }
  if (file.signingKeys.length >= keysMax || file.cookieKeys.length >= keysMax) {
    errors.push(`The key file already holds ${keysMax} keys of one kind. Retire old keys first.`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const signingKey: SigningKeyEntry = {
    addedAt: iso(options.now),
    jwk: generateSigningKey(),
    promotedAt: null,
  };
  const cookieKey = newCookieKey(options.now);
  return {
    ok: true,
    value: {
      changes: [
        `Published signing key ${signingKey.jwk.kid}. Promote it from ${iso(options.now + publishWaitMs)}.`,
        "Added a cookie key, which signs cookies from the next start.",
      ],
      file: {
        cookieKeys: [cookieKey, ...file.cookieKeys],
        signingKeys: [...file.signingKeys, signingKey],
      },
    },
  };
}

/** Start signing tokens with the published key that `rotate` added. */
export function promote(file: KeyFile, options: StepOptions): StepResult {
  const pending = pendingKey(file);
  if (pending === undefined) {
    return { ok: false, errors: ["No signing key is waiting to start signing. Rotate first."] };
  }
  const ready = Date.parse(pending.addedAt) + publishWaitMs;
  if (options.now < ready && options.skipWait !== true) {
    return {
      ok: false,
      errors: [
        `Signing key ${pending.jwk.kid} was published at ${pending.addedAt}. Solid servers may not have seen it yet. Promote it from ${iso(ready)}.`,
      ],
    };
  }

  const others = file.signingKeys.filter((key) => key !== pending);
  const promoted: SigningKeyEntry = { ...pending, promotedAt: iso(options.now) };
  return {
    ok: true,
    value: {
      changes: [
        `Signing key ${pending.jwk.kid} signs tokens from the next start. Retire older signing keys from ${iso(options.now + signingKeyRetireWaitMs)}.`,
      ],
      file: { cookieKeys: file.cookieKeys, signingKeys: [promoted, ...others] },
    },
  };
}

/**
 * Remove the old keys that nothing still in use was signed with: signing
 * keys once their tokens have expired, cookie keys once their sessions have.
 * A key waiting to start signing is kept.
 */
export function retire(file: KeyFile, options: StepOptions): StepResult {
  const signing = retireSigningKeys(file.signingKeys, options);
  const cookies = retireCookieKeys(file.cookieKeys, options);
  const changes = [...signing.changes, ...cookies.changes];
  const waiting = [...signing.waiting, ...cookies.waiting];

  if (changes.length === 0) {
    return {
      ok: false,
      errors: waiting.length > 0 ? waiting : ["There are no old keys to retire."],
    };
  }
  return {
    ok: true,
    value: {
      changes: [...changes, ...waiting],
      file: { cookieKeys: cookies.keys, signingKeys: signing.keys },
    },
  };
}

type Retired<T> = {
  readonly changes: readonly string[];
  readonly keys: readonly T[];
  readonly waiting: readonly string[];
};

// Old signing keys go once the tokens they signed have expired, counted from
// when the key that replaced them started signing. A waiting key stays.
function retireSigningKeys(
  keys: readonly SigningKeyEntry[],
  options: StepOptions,
): Retired<SigningKeyEntry> {
  const [active, ...rest] = keys;
  const old = rest.filter((key) => key.promotedAt !== null);
  // The key file's format guarantees the first key has started signing.
  if (typeof active?.promotedAt !== "string" || old.length === 0) {
    return { changes: [], keys, waiting: [] };
  }
  const ready = Date.parse(active.promotedAt) + signingKeyRetireWaitMs;
  if (options.now < ready && options.skipWait !== true) {
    const waiting = [`Old signing keys may still verify tokens. Retire them from ${iso(ready)}.`];
    return { changes: [], keys, waiting };
  }
  return {
    changes: old.map((key) => `Retired signing key ${key.jwk.kid}.`),
    keys: [active, ...rest.filter((key) => key.promotedAt === null)],
    waiting: [],
  };
}

// Old cookie keys go once the sessions they signed have expired, counted
// from when the newest cookie key was added.
function retireCookieKeys(
  keys: readonly CookieKeyEntry[],
  options: StepOptions,
): Retired<CookieKeyEntry> {
  const [newest, ...old] = keys;
  if (newest === undefined || old.length === 0) {
    return { changes: [], keys, waiting: [] };
  }
  const ready = Date.parse(newest.addedAt) + cookieKeyRetireWaitMs;
  if (options.now < ready && options.skipWait !== true) {
    const waiting = [`Old cookie keys may still verify sessions. Retire them from ${iso(ready)}.`];
    return { changes: [], keys, waiting };
  }
  return { changes: [`Retired ${count(old.length, "cookie key")}.`], keys: [newest], waiting: [] };
}

/**
 * Replace every key at once, keeping none, for keys that may have leaked.
 * Every token and session they signed stops working.
 */
export function revoke(file: KeyFile, options: Pick<StepOptions, "now">): StepResult {
  const replaced = newKeyFile(options.now);
  return {
    ok: true,
    value: {
      changes: [
        ...file.signingKeys.map((key) => `Removed signing key ${key.jwk.kid}.`),
        `Removed ${count(file.cookieKeys.length, "cookie key")}.`,
        `Signing key ${replaced.signingKeys[0]?.jwk.kid} and a new cookie key are in use from the next start.`,
      ],
      file: replaced,
    },
  };
}

/** Describe each key, one line each, for the key command's `list`. */
export function describeKeys(file: KeyFile): string[] {
  const signing = file.signingKeys.map((key, index) => {
    const state =
      index === 0
        ? `signs tokens, since ${key.promotedAt}`
        : key.promotedAt === null
          ? `published, waiting to sign, since ${key.addedAt}`
          : `published, stopped signing`;
    return `Signing key ${key.jwk.kid}: ${state}`;
  });
  const cookies = file.cookieKeys.map(
    (key, index) =>
      `Cookie key ${index + 1}: added ${key.addedAt}${index === 0 ? ", signs cookies" : ", verifies only"}`,
  );
  return [...signing, ...cookies];
}

function pendingKey(file: KeyFile): SigningKeyEntry | undefined {
  return file.signingKeys.find((key) => key.promotedAt === null);
}

function count(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}
