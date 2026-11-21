import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it, mock } from "node:test";

import { openDatabase, type ProviderDatabase, scheduleRemoval, schemaVersion } from "./database.ts";

const root = mkdtempSync(join(tmpdir(), "solid-oidc-database-"));
after(() => rmSync(root, { force: true, recursive: true }));

let fileCount = 0;
function freshPath(): string {
  fileCount += 1;
  return join(root, `provider-${fileCount}.sqlite`);
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    advanceSeconds(seconds: number) {
      now += seconds * 1000;
    },
    now: () => now,
  };
}

function open(path: string, now = clock().now): ProviderDatabase {
  const opened = openDatabase({ now, path });
  assert.ok(opened.ok, `expected ${path} to open: ${JSON.stringify(opened)}`);
  return opened.value;
}

describe("openDatabase", () => {
  it("creates a database readable only by its owner, at the current schema version", () => {
    const path = freshPath();

    using _database = open(path);

    assert.equal(statSync(path).mode & 0o777, 0o600);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], schemaVersion);
    assert.equal(raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
    raw.close();
  });

  it("keeps records across a reopen", async () => {
    const path = freshPath();
    {
      using database = open(path);
      await database.adapter("Session").upsert("s1", { accountId: "alice" }, 60);
    }

    using reopened = open(path);

    assert.deepEqual(await reopened.adapter("Session").find("s1"), { accountId: "alice" });
  });

  it("refuses a database with an unknown schema version", () => {
    const path = freshPath();
    open(path)[Symbol.dispose]();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    const opened = openDatabase({ now: Date.now, path });

    assert.ok(!opened.ok, "expected an unknown schema version to be refused");
    assert.deepEqual(opened.errors, [
      `DATA_DIR: ${path} has schema version 99, but this broker knows only version ${schemaVersion}`,
    ]);
  });

  it("refuses a database file that others can read", () => {
    const path = freshPath();
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    const opened = openDatabase({ now: Date.now, path });

    assert.ok(!opened.ok, "expected a group-readable database to be refused");
    assert.deepEqual(opened.errors, [
      `DATA_DIR: ${path} must be readable only by its owner (mode 600)`,
    ]);
  });

  it("reports a database file that can't be created", () => {
    const path = join(root, "missing-directory", "provider.sqlite");

    const opened = openDatabase({ now: Date.now, path });

    assert.ok(!opened.ok, "expected a missing directory to be reported");
    assert.deepEqual(opened.errors, [`DATA_DIR: could not open ${path} (ENOENT)`]);
  });

  it("reports a file that isn't a database", () => {
    const path = freshPath();
    writeFileSync(path, "not a database, but long enough to have a header ".repeat(4), {
      mode: 0o600,
    });

    const opened = openDatabase({ now: Date.now, path });

    assert.ok(!opened.ok, "expected a non-database file to be refused");
    assert.match(opened.errors[0] ?? "", /^DATA_DIR: could not open .* \(ERR_SQLITE_ERROR\)$/);
  });
});

describe("the provider adapter", () => {
  it("forgets a record once it expires", async () => {
    const time = clock();
    using database = open(":memory:", time.now);
    const sessions = database.adapter("Session");
    await sessions.upsert("s1", { accountId: "alice" }, 60);

    time.advanceSeconds(60);

    assert.equal(await sessions.find("s1"), undefined);
  });

  it("keeps a record with no expiry", async () => {
    const time = clock();
    using database = open(":memory:", time.now);
    await database.adapter("Client").upsert("c1", { client_id: "c1" });

    time.advanceSeconds(365 * 24 * 60 * 60);

    assert.deepEqual(await database.adapter("Client").find("c1"), { client_id: "c1" });
  });

  it("keeps models apart", async () => {
    using database = open(":memory:");
    await database.adapter("Session").upsert("same-id", { kind: "Session" }, 60);

    assert.equal(await database.adapter("Grant").find("same-id"), undefined);
  });

  it("marks a consumed record, and clears the mark when it is saved again", async () => {
    using database = open(":memory:");
    const codes = database.adapter("AuthorizationCode");
    await codes.upsert("code1", { grantId: "g1" }, 60);

    await codes.consume("code1");
    const consumed = await codes.find("code1");
    await codes.upsert("code1", { grantId: "g1" }, 60);
    const saved = await codes.find("code1");

    assert.equal(consumed?.consumed, 1_000);
    assert.equal(saved?.consumed, undefined);
  });

  it("destroys a record", async () => {
    using database = open(":memory:");
    const sessions = database.adapter("Session");
    await sessions.upsert("s1", { accountId: "alice" }, 60);

    await sessions.destroy("s1");

    assert.equal(await sessions.find("s1"), undefined);
  });

  it("finds a session by its uid and a device code by its user code", async () => {
    using database = open(":memory:");
    await database.adapter("Session").upsert("s1", { accountId: "alice", uid: "u1" }, 60);
    await database.adapter("DeviceCode").upsert("d1", { userCode: "ABCD-EFGH" }, 60);

    assert.equal((await database.adapter("Session").findByUid("u1"))?.accountId, "alice");
    assert.equal(
      (await database.adapter("DeviceCode").findByUserCode("ABCD-EFGH"))?.userCode,
      "ABCD-EFGH",
    );
  });

  it("revokes every record of a grant, in every model", async () => {
    using database = open(":memory:");
    await database.adapter("AccessToken").upsert("a1", { grantId: "g1" }, 60);
    await database.adapter("RefreshToken").upsert("r1", { grantId: "g1" }, 60);
    await database.adapter("RefreshToken").upsert("r2", { grantId: "g2" }, 60);

    await database.adapter("Grant").revokeByGrantId("g1");

    assert.equal(await database.adapter("AccessToken").find("a1"), undefined);
    assert.equal(await database.adapter("RefreshToken").find("r1"), undefined);
    assert.ok(
      await database.adapter("RefreshToken").find("r2"),
      "expected another grant's token to stay",
    );
  });
});

describe("removeExpired", () => {
  it("removes only expired records, at most the limit", async () => {
    const time = clock();
    using database = open(":memory:", time.now);
    const tokens = database.adapter("AccessToken");
    await Promise.all([
      tokens.upsert("old1", {}, 10),
      tokens.upsert("old2", {}, 10),
      tokens.upsert("old3", {}, 10),
      tokens.upsert("live", {}, 1_000),
    ]);
    time.advanceSeconds(10);

    const first = database.removeExpired(2);
    const second = database.removeExpired(2);

    assert.deepEqual([first, second], [2, 1]);
    assert.ok(await tokens.find("live"), "expected the live record to stay");
  });
});

describe("removeAll", () => {
  it("removes every record of every model, expired or not", async () => {
    using database = open(":memory:");
    await Promise.all([
      database.adapter("Session").upsert("session", {}, 1_000),
      database.adapter("Grant").upsert("grant", {}, 1_000),
      database.adapter("RefreshToken").upsert("refresh", { grantId: "grant" }, 1_000),
      database.adapter("Client").upsert("forever", {}, undefined),
    ]);

    const removed = database.removeAll();

    assert.equal(removed, 4);
    assert.equal(await database.adapter("Session").find("session"), undefined);
    assert.equal(await database.adapter("Client").find("forever"), undefined);
  });
});

describe("backUp", () => {
  it("writes a consistent copy readable only by its owner", async () => {
    using database = open(freshPath());
    await database.adapter("Session").upsert("s1", { accountId: "alice" }, 60);
    const destination = freshPath();

    const result = await database.backUp(destination);

    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    using copy = open(destination);
    assert.deepEqual(await copy.adapter("Session").find("s1"), { accountId: "alice" });
  });

  it("refuses to overwrite an existing file", async () => {
    using database = open(":memory:");
    const destination = freshPath();
    writeFileSync(destination, "keep me");

    const result = await database.backUp(destination);

    assert.ok(!result.ok, "expected an existing file to be refused");
    assert.deepEqual(result.errors, [`could not back up to ${destination} (EEXIST)`]);
  });
});

describe("scheduleRemoval", () => {
  it("removes expired records on each tick, and logs only a full batch", (context) => {
    context.mock.timers.enable({ apis: ["setInterval"] });
    const removedPerRun = [1_000, 3];
    const removeExpired = mock.fn((_limit: number) => removedPerRun.shift() ?? 0);
    const logs: unknown[] = [];

    using _removal = scheduleRemoval({
      batchSize: 1_000,
      database: { removeExpired },
      intervalMs: 60_000,
      log: (entry) => logs.push(entry),
    });
    context.mock.timers.tick(120_000);

    assert.deepEqual(
      removeExpired.mock.calls.map((call) => call.arguments),
      [[1_000], [1_000]],
    );
    assert.deepEqual(logs, [
      { level: "info", message: "Removed a full batch of expired records", removed: 1_000 },
    ]);
  });

  it("stops when disposed", (context) => {
    context.mock.timers.enable({ apis: ["setInterval"] });
    const removeExpired = mock.fn(() => 0);

    {
      using _removal = scheduleRemoval({
        batchSize: 10,
        database: { removeExpired },
        intervalMs: 1_000,
        log: () => undefined,
      });
    }
    context.mock.timers.tick(5_000);

    assert.equal(removeExpired.mock.callCount(), 0);
  });
});
