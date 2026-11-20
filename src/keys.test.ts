import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { generateProviderKeys, keysFileName, loadOrCreateKeys } from "./keys.ts";

const temporaryRoot = await mkdtemp(join(tmpdir(), "solid-oidc-keys-"));
after(() => rm(temporaryRoot, { force: true, recursive: true }));

let directoryCount = 0;
function freshDataDir(): string {
  directoryCount += 1;
  return join(temporaryRoot, `data-${directoryCount}`);
}

async function writeKeysFile(options: { dataDir: string; contents: string; mode?: number }) {
  const created = await loadOrCreateKeys(options.dataDir);
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
    assert.match(signingKey.kid, /^[A-Za-z0-9_-]{43}$/);
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

    const result = await loadOrCreateKeys(dataDir);

    assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
    const mode = (await stat(join(dataDir, keysFileName))).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 600, got ${mode.toString(8)}`);
  });

  it("reuses the same keys on a later start", async () => {
    const dataDir = freshDataDir();

    const first = await loadOrCreateKeys(dataDir);
    const second = await loadOrCreateKeys(dataDir);

    assert.ok(first.ok && second.ok, "expected both starts to succeed");
    assert.deepEqual(second.value, first.value);
  });

  it("creates new keys for an empty data directory", async () => {
    const first = await loadOrCreateKeys(freshDataDir());
    const second = await loadOrCreateKeys(freshDataDir());

    assert.ok(first.ok && second.ok, "expected both starts to succeed");
    assert.notEqual(second.value.signingKeys[0]?.kid, first.value.signingKeys[0]?.kid);
  });

  it("agrees on one set of keys when two starts race", async () => {
    const dataDir = freshDataDir();

    const results = await Promise.all([loadOrCreateKeys(dataDir), loadOrCreateKeys(dataDir)]);

    const [first, second] = results;
    assert.ok(first?.ok && second?.ok, "expected both starts to succeed");
    assert.deepEqual(second.value, first.value);
    const stored = JSON.parse(await readFile(join(dataDir, keysFileName), "utf8"));
    assert.deepEqual(stored.signingKeys, first.value.signingKeys);
  });

  it("leaves no temporary files behind", async () => {
    const dataDir = freshDataDir();

    await Promise.all([loadOrCreateKeys(dataDir), loadOrCreateKeys(dataDir)]);

    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dataDir), [keysFileName]);
  });

  it("refuses a key file that others can read", async () => {
    const dataDir = freshDataDir();
    const path = await writeKeysFile({ dataDir, contents: "{}", mode: 0o644 });

    const result = await loadOrCreateKeys(dataDir);

    assert.ok(!result.ok, "expected a group-readable key file to be refused");
    assert.deepEqual(result.errors, [
      `DATA_DIR: ${path} must be readable only by its owner (mode 600)`,
    ]);
  });

  it("refuses a key file that is not JSON without quoting it", async () => {
    const dataDir = freshDataDir();
    const path = await writeKeysFile({ dataDir, contents: '{"d": "private' });

    const result = await loadOrCreateKeys(dataDir);

    assert.ok(!result.ok, "expected invalid JSON to be refused");
    assert.deepEqual(result.errors, [`DATA_DIR: ${path} is not valid JSON`]);
  });

  it("refuses a key file with the wrong shape", async () => {
    const dataDir = freshDataDir();
    const keys = generateProviderKeys();
    const path = await writeKeysFile({
      dataDir,
      contents: JSON.stringify({ ...keys, version: 2 }),
    });

    const result = await loadOrCreateKeys(dataDir);

    assert.ok(!result.ok, "expected an unknown version to be refused");
    assert.match(result.errors[0] ?? "", new RegExp(`^DATA_DIR: ${path}: version: `));
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

    const result = await loadOrCreateKeys(dataDir);

    assert.ok(!result.ok, "expected a public-only key to be refused");
    assert.match(result.errors[0] ?? "", /signingKeys\.0\.d: /);
  });

  it("reports a data directory that is a file", async () => {
    const parent = freshDataDir();
    await loadOrCreateKeys(parent);
    const dataDir = join(parent, keysFileName);

    const result = await loadOrCreateKeys(dataDir);

    assert.ok(!result.ok, "expected a file as DATA_DIR to be refused");
    assert.deepEqual(result.errors, [
      `DATA_DIR: could not read ${join(dataDir, keysFileName)} (ENOTDIR)`,
    ]);
  });

  it("reports a data directory that cannot be created", async () => {
    const parent = freshDataDir();
    await loadOrCreateKeys(parent);
    await chmod(parent, 0o500);
    const dataDir = join(parent, "nested");

    try {
      const result = await loadOrCreateKeys(dataDir);

      assert.ok(!result.ok, "expected an unwritable parent to be refused");
      assert.match(result.errors[0] ?? "", /^DATA_DIR: could not create .* \((EACCES|EPERM)\)$/);
    } finally {
      await chmod(parent, 0o700);
    }
  });
});
