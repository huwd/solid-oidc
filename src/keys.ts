import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { errorCode, formatIssues, type Result } from "./validation.ts";

/** A private signing key, as a JWK for oidc-provider's `jwks` setting. */
export type SigningKey = {
  readonly alg: "ES256";
  readonly crv: "P-256";
  readonly d: string;
  readonly kid: string;
  readonly kty: "EC";
  readonly use: "sig";
  readonly x: string;
  readonly y: string;
};

/** Key material the provider needs to keep across restarts. */
export type ProviderKeys = {
  /** Keys for signing cookies, newest first. The first signs new cookies. */
  readonly cookieKeys: readonly string[];
  /**
   * Private keys for signing tokens. The first signs new tokens. All of them
   * are published, so tokens signed by any of them verify.
   */
  readonly signingKeys: readonly SigningKey[];
};

/** A cookie key, and when it was added. */
export type CookieKeyEntry = {
  /** An ISO 8601 date and time. */
  readonly addedAt: string;
  readonly key: string;
};

/** A signing key, when it was added, and when it started signing tokens. */
export type SigningKeyEntry = {
  /** An ISO 8601 date and time. */
  readonly addedAt: string;
  readonly jwk: SigningKey;
  /** When it started signing tokens, or null while it is only published. */
  readonly promotedAt: string | null;
};

/**
 * The contents of the key file. Signing keys are in signing order: the one
 * that signs first, then older keys, then at most one published key that has
 * not started signing yet. Cookie keys are newest first.
 */
export type KeyFile = {
  readonly cookieKeys: readonly CookieKeyEntry[];
  readonly signingKeys: readonly SigningKeyEntry[];
};

/** The name of the key file inside `DATA_DIR`. */
export const keysFileName = "keys.json";

/** The most keys of each kind the file holds. */
const keysMax = 10;

const keysFileVersion = 2;
const cookieKeyBytes = 32;

// The file holds private keys. Anything more permissive than owner
// read-and-write means another account on the host may have read them.
const keysFileMode = 0o600;
const groupAndOtherPermissions = 0o077;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be base64url");
const CookieKey = z.string().min(cookieKeyBytes);
const Timestamp = z.iso.datetime();

const SigningKeySchema = z.strictObject({
  alg: z.literal("ES256"),
  crv: z.literal("P-256"),
  d: Base64Url,
  kid: Base64Url,
  kty: z.literal("EC"),
  use: z.literal("sig"),
  x: Base64Url,
  y: Base64Url,
});

const KeysFileVersion1 = z.strictObject({
  cookieKeys: z.array(CookieKey).min(1).max(keysMax),
  signingKeys: z.array(SigningKeySchema).min(1).max(keysMax),
  version: z.literal(1),
});

const KeysFileVersion2 = z.strictObject({
  cookieKeys: z
    .array(z.strictObject({ addedAt: Timestamp, key: CookieKey }))
    .min(1)
    .max(keysMax),
  signingKeys: z
    .array(
      z.strictObject({
        addedAt: Timestamp,
        jwk: SigningKeySchema,
        promotedAt: Timestamp.nullable(),
      }),
    )
    .min(1)
    .max(keysMax)
    .refine((keys) => keys[0]?.promotedAt !== null, "the first key must have started signing")
    .refine(
      (keys) => keys.slice(0, -1).every((key) => key.promotedAt !== null),
      "only the last key may be waiting to start signing",
    ),
  version: z.literal(keysFileVersion),
});

/** The keys the provider uses, from the key file. */
export function providerKeys(file: KeyFile): ProviderKeys {
  return {
    cookieKeys: file.cookieKeys.map((entry) => entry.key),
    signingKeys: file.signingKeys.map((entry) => entry.jwk),
  };
}

/** A key file with one fresh key of each kind, both in use from `now`. */
export function newKeyFile(now: number): KeyFile {
  const at = new Date(now).toISOString();
  return {
    cookieKeys: [newCookieKey(now)],
    signingKeys: [{ addedAt: at, jwk: generateSigningKey(), promotedAt: at }],
  };
}

/** A fresh cookie key, added at `now`. */
function newCookieKey(now: number): CookieKeyEntry {
  return {
    addedAt: new Date(now).toISOString(),
    key: randomBytes(cookieKeyBytes).toString("base64url"),
  };
}

/** Generate a fresh signing key and cookie key. */
export function generateProviderKeys(): ProviderKeys {
  return providerKeys(newKeyFile(Date.now()));
}

/**
 * Load the provider's keys from `DATA_DIR`, creating them on first start.
 * Later starts reuse the same keys, so tokens and sessions issued before a
 * restart stay valid.
 */
export async function loadOrCreateKeys(options: {
  readonly dataDir: string;
  readonly now: () => number;
}): Promise<Result<ProviderKeys>> {
  const loaded = await loadOrCreateKeyFile(options);
  return loaded.ok ? { ok: true, value: providerKeys(loaded.value) } : loaded;
}

async function loadOrCreateKeyFile(options: {
  readonly dataDir: string;
  readonly now: () => number;
}): Promise<Result<KeyFile>> {
  const path = join(options.dataDir, keysFileName);
  const existing = await readKeysFile(path);
  if (existing.kind === "found") {
    return existing.result;
  }

  const file = newKeyFile(options.now());
  let created: boolean;
  try {
    await mkdir(options.dataDir, { mode: 0o700, recursive: true });
    created = await createExclusively({ contents: serialise(file), path });
  } catch (error) {
    return { ok: false, errors: [`DATA_DIR: could not create ${path} (${errorCode(error)})`] };
  }
  if (created) {
    return { ok: true, value: file };
  }
  // Another process created the file first. Use its keys, so both agree.
  const raced = await readKeysFile(path);
  /* node:coverage ignore next 4 */
  // Unreachable: the file existed a moment ago when the link failed.
  if (raced.kind === "missing") {
    return { ok: false, errors: [`DATA_DIR: ${path} disappeared while starting`] };
  }
  return raced.result;
}

/**
 * Read the key file, with when each key was added. Unlike a start, a missing
 * file is an error.
 */
export async function readKeyFile(dataDir: string): Promise<Result<KeyFile>> {
  const path = join(dataDir, keysFileName);
  const read = await readKeysFile(path);
  if (read.kind === "missing") {
    return {
      ok: false,
      errors: [`DATA_DIR: ${path} does not exist. Start the broker once to create it.`],
    };
  }
  return read.result;
}

type ReadOutcome =
  | { readonly kind: "found"; readonly result: Result<KeyFile> }
  | { readonly kind: "missing" };

async function readKeysFile(path: string): Promise<ReadOutcome> {
  let text: string;
  let stats: { readonly mode: number; readonly mtimeMs: number };
  try {
    [text, stats] = await Promise.all([readFile(path, { encoding: "utf8" }), stat(path)]);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    const errors = [`DATA_DIR: could not read ${path} (${code})`];
    return { kind: "found", result: { ok: false, errors } };
  }

  if ((stats.mode & groupAndOtherPermissions) !== 0) {
    const errors = [`DATA_DIR: ${path} must be readable only by its owner (mode 600)`];
    return { kind: "found", result: { ok: false, errors } };
  }
  return { kind: "found", result: parseKeysFile({ modifiedAt: stats.mtimeMs, path, text }) };
}

function parseKeysFile(options: {
  readonly modifiedAt: number;
  readonly path: string;
  readonly text: string;
}): Result<KeyFile> {
  let json: unknown;
  try {
    json = JSON.parse(options.text);
  } catch {
    // The parser's message can quote the file, which holds private keys.
    return { ok: false, errors: [`DATA_DIR: ${options.path} is not valid JSON`] };
  }

  // A file from before key rotation has no dates. Treat its keys as added,
  // and in use, when the file was last written. Every wait is measured from
  // a newer key's date, so these dates only appear in the key command's list.
  const isVersion1 =
    typeof json === "object" && json !== null && "version" in json && json.version === 1;
  if (isVersion1) {
    const version1 = KeysFileVersion1.safeParse(json);
    if (!version1.success) {
      return { ok: false, errors: issuesIn(options.path, version1.error) };
    }
    const at = new Date(options.modifiedAt).toISOString();
    return {
      ok: true,
      value: {
        cookieKeys: version1.data.cookieKeys.map((key) => ({ addedAt: at, key })),
        signingKeys: version1.data.signingKeys.map((jwk) => ({ addedAt: at, jwk, promotedAt: at })),
      },
    };
  }

  const parsed = KeysFileVersion2.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: issuesIn(options.path, parsed.error) };
  }
  return {
    ok: true,
    value: { cookieKeys: parsed.data.cookieKeys, signingKeys: parsed.data.signingKeys },
  };
}

function issuesIn(path: string, error: z.ZodError): string[] {
  return formatIssues(error).map((issue) => `DATA_DIR: ${path}: ${issue}`);
}

// Write to a temporary file, then hard-link it into place. The link fails if
// the file already exists, so a concurrent start can't overwrite keys that
// are already in use, and a crash part-way through never leaves a partial
// key file behind.
async function createExclusively(options: {
  readonly contents: string;
  readonly path: string;
}): Promise<boolean> {
  const temporaryPath = temporaryPathFor(options.path);
  await writeFile(temporaryPath, options.contents, { flag: "wx", mode: keysFileMode });

  let linked = true;
  try {
    await link(temporaryPath, options.path);
  } catch (error) {
    /* node:coverage ignore next 5 */
    // Platform-specific: only a file system without hard links fails this way.
    if (errorCode(error) !== "EEXIST") {
      await unlink(temporaryPath);
      throw error;
    }
    linked = false;
  }

  await unlink(temporaryPath);
  return linked;
}

function temporaryPathFor(path: string): string {
  return `${path}.${randomBytes(8).toString("hex")}.tmp`;
}

function serialise(file: KeyFile): string {
  return `${JSON.stringify({ ...file, version: keysFileVersion }, null, 2)}\n`;
}

/** Generate a fresh ES256 signing key, whose ID is its thumbprint. */
function generateSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  /* node:coverage ignore next 4 */
  // Unreachable: Node always exports a P-256 private key with these members.
  if (jwk.d === undefined || jwk.x === undefined || jwk.y === undefined) {
    throw new Error("Node exported an incomplete P-256 key");
  }
  return {
    alg: "ES256",
    crv: "P-256",
    d: jwk.d,
    kid: thumbprint({ x: jwk.x, y: jwk.y }),
    kty: "EC",
    use: "sig",
    x: jwk.x,
    y: jwk.y,
  };
}

// RFC 7638 JWK thumbprint: the SHA-256 of the required public members, in
// lexicographic order with no whitespace. Using it as the key ID makes the ID
// a pure function of the key.
function thumbprint(point: { readonly x: string; readonly y: string }): string {
  const members = JSON.stringify({ crv: "P-256", kty: "EC", x: point.x, y: point.y });
  return createHash("sha256").update(members).digest("base64url");
}
