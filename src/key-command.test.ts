import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { databaseFileName, openDatabase } from "./database.ts";
import { keyCommandUsage, runKeyCommand } from "./key-command.ts";
import { publishWaitMs } from "./key-rotation.ts";
import { loadOrCreateKeys, readKeyFile } from "./keys.ts";

const root = await mkdtemp(join(tmpdir(), "solid-oidc-key-command-"));
after(() => rm(root, { force: true, recursive: true }));

let count = 0;
async function dataDirWithKeys(now = Date.now()): Promise<string> {
  count += 1;
  const dataDir = join(root, `data-${count}`);
  const created = await loadOrCreateKeys({ dataDir, now: () => now });
  assert.ok(created.ok, "expected keys to be created");
  return dataDir;
}

async function run(dataDir: string, args: string[], now = Date.now()) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runKeyCommand({
    args,
    dataDir,
    now: () => now,
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
  });
  return { code, errors, out };
}

describe("runKeyCommand", () => {
  for (const args of [[], ["spin"], ["rotate", "--skip-wait"], ["revoke", "--skip-wait"]]) {
    it(`shows the usage for ${JSON.stringify(args)}`, async () => {
      const result = await run(join(root, "unused"), args);

      assert.deepEqual(result, { code: 2, errors: [keyCommandUsage], out: [] });
    });
  }

  it("refuses to revoke without --confirm", async () => {
    const dataDir = await dataDirWithKeys();

    const result = await run(dataDir, ["revoke"]);

    assert.equal(result.code, 2);
    assert.match(result.errors[0] ?? "", /Run it with --confirm/);
  });

  it("reports a missing key file", async () => {
    const result = await run(join(root, "empty"), ["list"]);

    assert.equal(result.code, 1);
    assert.match(result.errors[0] ?? "", /does not exist\. Start the broker once to create it\.$/);
  });

  it("lists the keys", async () => {
    const dataDir = await dataDirWithKeys(Date.parse("2026-03-01T09:00:00.000Z"));

    const result = await run(dataDir, ["list"]);

    assert.equal(result.code, 0);
    assert.match(result.out[0] ?? "", /: signs tokens, since 2026-03-01T09:00:00\.000Z$/);
    assert.equal(result.out[1], "Cookie key 1: added 2026-03-01T09:00:00.000Z, signs cookies");
  });

  it("rotates, promotes after the wait, and says to restart", async () => {
    const start = Date.now();
    const dataDir = await dataDirWithKeys(start);

    const rotated = await run(dataDir, ["rotate"], start);
    const early = await run(dataDir, ["promote"], start);
    const promoted = await run(dataDir, ["promote"], start + publishWaitMs);

    assert.equal(rotated.code, 0);
    assert.equal(rotated.out.at(-1), "Restart the broker to use the changed keys.");
    assert.equal(early.code, 1, "expected an early promote to be refused");
    assert.equal(promoted.code, 0);
    const file = await readKeyFile(dataDir);
    assert.ok(file.ok);
    assert.equal(file.value.signingKeys.length, 2);
    assert.notEqual(file.value.signingKeys[0]?.promotedAt, null);
  });

  it("promotes and retires early with --skip-wait", async () => {
    const dataDir = await dataDirWithKeys();
    await run(dataDir, ["rotate"]);

    const promoted = await run(dataDir, ["promote", "--skip-wait"]);
    const retired = await run(dataDir, ["retire", "--skip-wait"]);

    assert.deepEqual([promoted.code, retired.code], [0, 0]);
    const file = await readKeyFile(dataDir);
    assert.ok(file.ok);
    assert.equal(file.value.signingKeys.length, 1);
    assert.equal(file.value.cookieKeys.length, 1);
  });

  it("leaves the file unchanged when a step is refused", async () => {
    const dataDir = await dataDirWithKeys();
    const before = await readKeyFile(dataDir);

    const result = await run(dataDir, ["retire"]);

    assert.deepEqual(result.errors, ["There are no old keys to retire."]);
    assert.equal(result.code, 1);
    assert.deepEqual(await readKeyFile(dataDir), before);
  });

  it("reports a key file that cannot be written", async () => {
    const dataDir = await dataDirWithKeys();
    await chmod(dataDir, 0o500);

    try {
      const result = await run(dataDir, ["rotate"]);

      assert.equal(result.code, 1);
      assert.match(result.errors[0] ?? "", /could not write .* \((EACCES|EPERM)\)$/);
    } finally {
      await chmod(dataDir, 0o700);
    }
  });

  it("deletes every session and token, then replaces the keys, when revoking", async () => {
    const dataDir = await dataDirWithKeys();
    const before = await readKeyFile(dataDir);
    {
      const opened = openDatabase({ now: Date.now, path: join(dataDir, databaseFileName) });
      assert.ok(opened.ok);
      using database = opened.value;
      await database.adapter("Session").upsert("session", {}, 1_000);
    }

    const result = await run(dataDir, ["revoke", "--confirm"]);

    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.equal(result.out[0], "Deleted 1 sessions, grants, codes and tokens.");
    const after = await readKeyFile(dataDir);
    assert.ok(before.ok && after.ok);
    assert.notEqual(after.value.signingKeys[0]?.jwk.kid, before.value.signingKeys[0]?.jwk.kid);
  });

  it("keeps the keys when the database cannot be opened while revoking", async () => {
    const dataDir = await dataDirWithKeys();
    const before = await readKeyFile(dataDir);
    const databasePath = join(dataDir, databaseFileName);
    await writeFile(databasePath, "");
    await chmod(databasePath, 0o644);

    const result = await run(dataDir, ["revoke", "--confirm"]);

    assert.equal(result.code, 1);
    assert.deepEqual(result.errors, [
      `DATA_DIR: ${databasePath} must be readable only by its owner (mode 600)`,
    ]);
    assert.deepEqual(await readKeyFile(dataDir), before);
  });
});
