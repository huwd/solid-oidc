import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  generateProviderKeys,
  type KeyFile,
  keysFileName,
  loadOrCreateKeys,
  newKeyFile,
  providerKeys,
  readKeyFile,
  replaceKeyFile,
} from "./keys.ts";

const temporaryRoot = await mkdtemp(join(tmpdir(), "solid-oidc-keys-"));
after(() => rm(temporaryRoot, { force: true, recursive: true }));

let directoryCount = 0;
function freshDataDir(): string {
  directoryCount += 1;
  return join(temporaryRoot, `data-${directoryCount}`);
}

async function writeKeysFile(options: { dataDir: string; contents: string; mode?: number }) {
  const created = await loadOrCreateKeys({ dataDir: options.dataDir, now: Date.now });
  assert.ok(created.ok, "expected the data directory to be created");
  const path = join(options.dataDir, keysFileName);
  await writeFile(path, options.contents);
  await chmod(path, options.mode ?? 0o600);
  return path;
}

describe("generateProviderKeys", () => {
  it("generates an ES256 signing key whose ID is its RFC 7638 thumbprint", () => {
    const keys = generateProviderKeys();
    const [signingKey] = keys.signingKeys;

    assert.ok(signingKey, "expected a signing key");
    assert.equal(signingKey.alg, "ES256");
    assert.equal(signingKey.use, "sig");
    const members = `{"crv":"P-256","kty":"EC","x":"${signingKey.x}","y":"${signingKey.y}"}`;
    assert.equal(signingKey.kid, createHash("sha256").update(members).digest("base64url"));
    assert.equal(keys.cookieKeys.length, 1);
  });

  it("generates different keys each time", () => {
    const first = generateProviderKeys();
    const second = generateProviderKeys();

    assert.notEqual(first.signingKeys[0]?.kid, second.signingKeys[0]?.kid);
    assert.notEqual(first.cookieKeys[0], second.cookieKeys[0]);
  });
});

describe("loadOrCreateKeys", () => {
  it("creates the data directory and a key file readable only by its owner", async () => {
    const dataDir = freshDataDir();

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
    const mode = (await stat(join(dataDir, keysFileName))).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 600, got ${mode.toString(8)}`);
  });

  it("reuses the same keys on a later start", async () => {
    const dataDir = freshDataDir();

    const first = await loadOrCreateKeys({ dataDir, now: Date.now });
    const second = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(first.ok && second.ok, "expected both starts to succeed");
    assert.deepEqual(second.value, first.value);
  });

  it("creates new keys for an empty data directory", async () => {
    const first = await loadOrCreateKeys({ dataDir: freshDataDir(), now: Date.now });
    const second = await loadOrCreateKeys({ dataDir: freshDataDir(), now: Date.now });

    assert.ok(first.ok && second.ok, "expected both starts to succeed");
    assert.notEqual(second.value.signingKeys[0]?.kid, first.value.signingKeys[0]?.kid);
  });

  it("agrees on one set of keys when two starts race", async () => {
    const dataDir = freshDataDir();

    const results = await Promise.all([
      loadOrCreateKeys({ dataDir, now: Date.now }),
      loadOrCreateKeys({ dataDir, now: Date.now }),
    ]);

    const [first, second] = results;
    assert.ok(first?.ok && second?.ok, "expected both starts to succeed");
    assert.deepEqual(second.value, first.value);
    const stored = JSON.parse(await readFile(join(dataDir, keysFileName), "utf8"));
    assert.deepEqual(
      stored.signingKeys.map((entry: { jwk: unknown }) => entry.jwk),
      first.value.signingKeys,
    );
  });

  it("leaves no temporary files behind", async () => {
    const dataDir = freshDataDir();

    await Promise.all([
      loadOrCreateKeys({ dataDir, now: Date.now }),
      loadOrCreateKeys({ dataDir, now: Date.now }),
    ]);

    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dataDir), [keysFileName]);
  });

  it("refuses a key file that others can read", async () => {
    const dataDir = freshDataDir();
    const path = await writeKeysFile({ dataDir, contents: "{}", mode: 0o644 });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected a group-readable key file to be refused");
    assert.deepEqual(result.errors, [
      `DATA_DIR: ${path} must be readable only by its owner (mode 600)`,
    ]);
  });

  it("refuses a key file that is not JSON without quoting it", async () => {
    const dataDir = freshDataDir();
    const path = await writeKeysFile({ dataDir, contents: '{"d": "private' });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected invalid JSON to be refused");
    assert.deepEqual(result.errors, [`DATA_DIR: ${path} is not valid JSON`]);
  });

  it("refuses a key file with the wrong shape", async () => {
    const dataDir = freshDataDir();
    const path = await writeKeysFile({
      dataDir,
      contents: JSON.stringify({ ...newKeyFile(Date.now()), version: 3 }),
    });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected an unknown version to be refused");
    assert.match(result.errors[0] ?? "", new RegExp(`^DATA_DIR: ${path}: version: `));
  });

  for (const [name, contents] of [
    ["a number", "5"],
    ["null", "null"],
    ["a string", '"keys"'],
  ] as const) {
    it(`refuses a key file holding ${name}, not an object`, async () => {
      const dataDir = freshDataDir();
      const path = await writeKeysFile({ dataDir, contents });

      const result = await loadOrCreateKeys({ dataDir, now: Date.now });

      assert.ok(!result.ok, "expected the file to be refused");
      assert.match(result.errors[0] ?? "", new RegExp(`^DATA_DIR: ${path}: `));
    });
  }

  it("refuses a key ID with a character that isn't base64url at the end", async () => {
    const dataDir = freshDataDir();
    const file = newKeyFile(Date.now());
    const [entry] = file.signingKeys;
    assert.ok(entry, "expected a signing key");
    await writeKeysFile({
      dataDir,
      contents: JSON.stringify({
        ...file,
        signingKeys: [{ ...entry, jwk: { ...entry.jwk, kid: `${entry.jwk.kid}!` } }],
        version: 2,
      }),
    });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected the key ID to be refused");
    assert.match(result.errors[0] ?? "", /signingKeys\.0\.jwk\.kid: must be base64url/);
  });

  it("refuses a signing key that is not a private ES256 key", async () => {
    const dataDir = freshDataDir();
    const keys = generateProviderKeys();
    const [signingKey] = keys.signingKeys;
    assert.ok(signingKey, "expected a signing key");
    const { d: _privatePart, ...publicKey } = signingKey;
    await writeKeysFile({
      dataDir,
      contents: JSON.stringify({ ...keys, signingKeys: [publicKey], version: 1 }),
    });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected a public-only key to be refused");
    assert.match(result.errors[0] ?? "", /signingKeys\.0\.d: /);
  });

  it("reports a data directory that is a file", async () => {
    const parent = freshDataDir();
    await loadOrCreateKeys({ dataDir: parent, now: Date.now });
    const dataDir = join(parent, keysFileName);

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected a file as DATA_DIR to be refused");
    assert.deepEqual(result.errors, [
      `DATA_DIR: could not read ${join(dataDir, keysFileName)} (ENOTDIR)`,
    ]);
  });

  it("reports a data directory that cannot be created", async () => {
    const parent = freshDataDir();
    await loadOrCreateKeys({ dataDir: parent, now: Date.now });
    await chmod(parent, 0o500);
    const dataDir = join(parent, "nested");

    try {
      const result = await loadOrCreateKeys({ dataDir, now: Date.now });

      assert.ok(!result.ok, "expected an unwritable parent to be refused");
      assert.match(result.errors[0] ?? "", /^DATA_DIR: could not create .* \((EACCES|EPERM)\)$/);
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it("refuses a version 2 signing key that is not a private key", async () => {
    const dataDir = freshDataDir();
    const file = newKeyFile(Date.now());
    const [entry] = file.signingKeys;
    assert.ok(entry, "expected a signing key");
    const { d: _privatePart, ...publicKey } = entry.jwk;
    await writeKeysFile({
      dataDir,
      contents: JSON.stringify({
        ...file,
        signingKeys: [{ ...entry, jwk: publicKey }],
        version: 2,
      }),
    });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected a public-only key to be refused");
    assert.match(result.errors[0] ?? "", /signingKeys\.0\.jwk\.d: /);
  });

  it("refuses a key file whose first signing key has not started signing", async () => {
    const dataDir = freshDataDir();
    const file = newKeyFile(Date.now());
    const pendingFirst = file.signingKeys.map((entry) => ({ ...entry, promotedAt: null }));
    await writeKeysFile({
      dataDir,
      contents: JSON.stringify({ ...file, signingKeys: pendingFirst, version: 2 }),
    });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected a waiting first key to be refused");
    assert.match(result.errors[0] ?? "", /signingKeys: the first key must have started signing$/);
  });

  it("refuses a key file with a waiting signing key before the last place", async () => {
    const dataDir = freshDataDir();
    const [active] = newKeyFile(Date.now()).signingKeys;
    const [waiting] = newKeyFile(Date.now()).signingKeys;
    const [older] = newKeyFile(Date.now()).signingKeys;
    assert.ok(active && waiting && older, "expected signing keys");
    const file = {
      ...newKeyFile(Date.now()),
      signingKeys: [active, { ...waiting, promotedAt: null }, older],
    };
    await writeKeysFile({ dataDir, contents: JSON.stringify({ ...file, version: 2 }) });

    const result = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(!result.ok, "expected a waiting key in the middle to be refused");
    assert.match(result.errors[0] ?? "", /only the last key may be waiting to start signing$/);
  });

  it("reads a key file from before key rotation, dated when it was written", async () => {
    const dataDir = freshDataDir();
    const keys = generateProviderKeys();
    const path = await writeKeysFile({
      dataDir,
      contents: JSON.stringify({ ...keys, version: 1 }),
    });
    const written = new Date((await stat(path)).mtimeMs).toISOString();

    const loaded = await loadOrCreateKeys({ dataDir, now: Date.now });
    const file = await readKeyFile(dataDir);

    assert.ok(loaded.ok && file.ok, "expected a version 1 file to be read");
    assert.deepEqual(loaded.value, keys);
    assert.deepEqual(file.value.cookieKeys[0]?.addedAt, written);
    assert.deepEqual(file.value.signingKeys[0]?.promotedAt, written);
  });

  it("reads every signing key in a file from before key rotation", async () => {
    const dataDir = freshDataDir();
    const keys = generateProviderKeys();
    const older = generateProviderKeys().signingKeys;
    await writeKeysFile({
      dataDir,
      contents: JSON.stringify({
        ...keys,
        signingKeys: [...keys.signingKeys, ...older],
        version: 1,
      }),
    });

    const loaded = await loadOrCreateKeys({ dataDir, now: Date.now });

    assert.ok(loaded.ok, `expected two signing keys to be read: ${JSON.stringify(loaded)}`);
    assert.equal(loaded.value.signingKeys.length, 2);
  });
});

describe("providerKeys", () => {
  it("keeps the key file's order, so the first key signs", () => {
    const file: KeyFile = {
      cookieKeys: [...newKeyFile(1).cookieKeys, ...newKeyFile(0).cookieKeys],
      signingKeys: [...newKeyFile(1).signingKeys, ...newKeyFile(0).signingKeys],
    };

    const keys = providerKeys(file);

    assert.deepEqual(
      keys.cookieKeys,
      file.cookieKeys.map((entry) => entry.key),
    );
    assert.deepEqual(
      keys.signingKeys,
      file.signingKeys.map((entry) => entry.jwk),
    );
  });
});

describe("readKeyFile and replaceKeyFile", () => {
  it("reports a missing key file", async () => {
    const dataDir = freshDataDir();

    const result = await readKeyFile(dataDir);

    assert.ok(!result.ok, "expected a missing file to be reported");
    assert.deepEqual(result.errors, [
      `DATA_DIR: ${join(dataDir, keysFileName)} does not exist. Start the broker once to create it.`,
    ]);
  });

  it("replaces the key file, readable only by its owner, with no temporary files left", async () => {
    const dataDir = freshDataDir();
    await loadOrCreateKeys({ dataDir, now: Date.now });
    const replacement = newKeyFile(Date.parse("2026-01-02T03:04:05.000Z"));

    const written = await replaceKeyFile(dataDir, replacement);
    const read = await readKeyFile(dataDir);

    assert.ok(written.ok && read.ok, "expected the file to be replaced and read back");
    assert.deepEqual(read.value, replacement);
    const mode = (await stat(join(dataDir, keysFileName))).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 600, got ${mode.toString(8)}`);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dataDir), [keysFileName]);
  });

  it("reports a key file that cannot be written", async () => {
    const dataDir = join(freshDataDir(), "missing");

    const result = await replaceKeyFile(dataDir, newKeyFile(Date.now()));

    assert.ok(!result.ok, "expected a missing directory to be reported");
    assert.deepEqual(result.errors, [
      `DATA_DIR: could not write ${join(dataDir, keysFileName)} (ENOENT)`,
    ]);
  });
});
