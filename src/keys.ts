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
  /** Keys for signing cookies, newest first. */
  readonly cookieKeys: readonly string[];
  /** Private keys for signing tokens, the one in use first. */
  readonly signingKeys: readonly SigningKey[];
};

/** The name of the key file inside `DATA_DIR`. */
export const keysFileName = "keys.json";

const keysFileVersion = 1;
const cookieKeyBytes = 32;

// The file holds private keys. Anything more permissive than owner
// read-and-write means another account on the host may have read them.
const keysFileMode = 0o600;
const groupAndOtherPermissions = 0o077;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be base64url");

const KeysFile = z.strictObject({
  cookieKeys: z.array(z.string().min(cookieKeyBytes)).min(1).max(10),
  signingKeys: z
    .array(
      z.strictObject({
        alg: z.literal("ES256"),
        crv: z.literal("P-256"),
        d: Base64Url,
        kid: Base64Url,
        kty: z.literal("EC"),
        use: z.literal("sig"),
        x: Base64Url,
        y: Base64Url,
      }),
    )
    .min(1)
    .max(10),
  version: z.literal(keysFileVersion),
});

/** Generate a fresh signing key and cookie key. */
export function generateProviderKeys(): ProviderKeys {
  return {
    cookieKeys: [randomBytes(cookieKeyBytes).toString("base64url")],
    signingKeys: [generateSigningKey()],
  };
}

/**
 * Load the provider's keys from `DATA_DIR`, creating them on first start.
 * Later starts reuse the same keys, so tokens and sessions issued before a
 * restart stay valid.
 */
export async function loadOrCreateKeys(dataDir: string): Promise<Result<ProviderKeys>> {
  const path = join(dataDir, keysFileName);
  const existing = await readKeysFile(path);
  if (existing.kind === "found") {
    return existing.result;
  }

  const keys = generateProviderKeys();
  let created: boolean;
  try {
    await mkdir(dataDir, { mode: 0o700, recursive: true });
    created = await createExclusively({ contents: serialise(keys), path });
  } catch (error) {
    return { ok: false, errors: [`DATA_DIR: could not create ${path} (${errorCode(error)})`] };
  }
  if (created) {
    return { ok: true, value: keys };
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

type ReadOutcome =
  | { readonly kind: "found"; readonly result: Result<ProviderKeys> }
  | { readonly kind: "missing" };

async function readKeysFile(path: string): Promise<ReadOutcome> {
  let text: string;
  let mode: number;
  try {
    [text, mode] = await Promise.all([
      readFile(path, { encoding: "utf8" }),
      stat(path).then((stats) => stats.mode),
    ]);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    const errors = [`DATA_DIR: could not read ${path} (${code})`];
    return { kind: "found", result: { ok: false, errors } };
  }

  if ((mode & groupAndOtherPermissions) !== 0) {
    const errors = [`DATA_DIR: ${path} must be readable only by its owner (mode 600)`];
    return { kind: "found", result: { ok: false, errors } };
  }
  return { kind: "found", result: parseKeysFile({ path, text }) };
}

function parseKeysFile(options: {
  readonly path: string;
  readonly text: string;
}): Result<ProviderKeys> {
  let json: unknown;
  try {
    json = JSON.parse(options.text);
  } catch {
    // The parser's message can quote the file, which holds private keys.
    return { ok: false, errors: [`DATA_DIR: ${options.path} is not valid JSON`] };
  }

  const parsed = KeysFile.safeParse(json);
  if (!parsed.success) {
    const errors = formatIssues(parsed.error).map((error) => `DATA_DIR: ${options.path}: ${error}`);
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { cookieKeys: parsed.data.cookieKeys, signingKeys: parsed.data.signingKeys },
  };
}

// Write to a temporary file, then hard-link it into place. The link fails if
// the file already exists, so a concurrent start can't overwrite keys that
// are already in use, and a crash part-way through never leaves a partial
// key file behind.
async function createExclusively(options: {
  readonly contents: string;
  readonly path: string;
}): Promise<boolean> {
  const temporaryPath = `${options.path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, options.contents, { flag: "wx", mode: keysFileMode });

  let linked = true;
  try {
    await link(temporaryPath, options.path);
  } catch (error) {
    /* node:coverage ignore next 5 */
    // Platform-specific: only a filesystem without hard links fails this way.
    if (errorCode(error) !== "EEXIST") {
      await unlink(temporaryPath);
      throw error;
    }
    linked = false;
  }

  await unlink(temporaryPath);
  return linked;
}

function serialise(keys: ProviderKeys): string {
  return `${JSON.stringify({ ...keys, version: keysFileVersion }, null, 2)}\n`;
}

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
