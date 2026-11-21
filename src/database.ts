import { closeSync, openSync, statSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import type { Adapter, AdapterFactory, AdapterPayload } from "oidc-provider";
import { z } from "zod";

import { errorCode, type Result } from "./validation.ts";

/**
 * The provider's state in SQLite: sessions, grants, codes and tokens. See
 * docs/decisions/0005-sqlite-for-provider-state.md.
 */
export type ProviderDatabase = Disposable & {
  /** oidc-provider's `adapter` setting. */
  readonly adapter: AdapterFactory;
  /**
   * Copy the database consistently, even while the broker writes to it, to
   * a new file readable only by its owner. Refuses to overwrite a file.
   */
  backUp(destination: string): Promise<Result<void>>;
  /**
   * Delete every session, grant, code and token, and return how many went.
   * Everyone has to log in again.
   */
  removeAll(): number;
  /** Delete up to `limit` expired records, and return how many went. */
  removeExpired(limit: number): number;
};

export type OpenDatabaseOptions = {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** A file path, or `:memory:` for tests. */
  readonly path: string;
};

/** The name of the database file inside `DATA_DIR`. */
export const databaseFileName = "provider.sqlite";

/**
 * The schema this code reads and writes. A database with any other version
 * was written by other code, so the broker refuses it rather than guess.
 */
export const schemaVersion = 1;

// The database holds live tokens, so like the key file it must be readable
// only by its owner. SQLite gives its -wal and -shm files the same mode.
const databaseFileMode = 0o600;
const groupAndOtherPermissions = 0o077;

const schema = `
CREATE TABLE records (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  grant_id TEXT,
  user_code TEXT,
  uid TEXT,
  expires_at INTEGER,
  consumed_at INTEGER,
  PRIMARY KEY (model, id)
) STRICT;
CREATE INDEX records_by_grant ON records (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX records_by_user_code ON records (model, user_code) WHERE user_code IS NOT NULL;
CREATE INDEX records_by_uid ON records (model, uid) WHERE uid IS NOT NULL;
CREATE INDEX records_by_expiry ON records (expires_at) WHERE expires_at IS NOT NULL;
PRAGMA user_version = ${schemaVersion};
`;

/**
 * Open the database, creating it with the current schema if it's new.
 * Refuses a database whose schema version this code doesn't know, or a file
 * that others can read.
 */
export function openDatabase(options: OpenDatabaseOptions): Result<ProviderDatabase> {
  const fileProblem = options.path === ":memory:" ? undefined : prepareFile(options.path);
  if (fileProblem !== undefined) {
    return { ok: false, errors: [fileProblem] };
  }

  const database = new DatabaseSync(options.path);
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const version = readSchemaVersion(database);
    if (version === 0) {
      database.exec(`BEGIN; ${schema} COMMIT;`);
    } else if (version !== schemaVersion) {
      // Stryker disable next-line CallExpression: the handle isn't returned, so tests can't see it
      // closed. Closing frees it now rather than at garbage collection.
      database.close();
      const errors = [
        `DATA_DIR: ${options.path} has schema version ${version}, but this broker knows only version ${schemaVersion}`,
      ];
      return { ok: false, errors };
    }
  } catch (error) {
    // Stryker disable next-line CallExpression: as above.
    database.close();
    return {
      ok: false,
      errors: [`DATA_DIR: could not open ${options.path} (${errorCode(error)})`],
    };
  }

  return { ok: true, value: providerDatabase({ database, now: options.now }) };
}

function providerDatabase(options: {
  readonly database: DatabaseSync;
  readonly now: () => number;
}): ProviderDatabase {
  const { database, now } = options;
  const statements = {
    consume: database.prepare("UPDATE records SET consumed_at = ? WHERE model = ? AND id = ?"),
    destroy: database.prepare("DELETE FROM records WHERE model = ? AND id = ?"),
    find: database.prepare(
      "SELECT payload, consumed_at FROM records WHERE model = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)",
    ),
    findByUid: database.prepare(
      "SELECT payload, consumed_at FROM records WHERE model = ? AND uid = ? AND (expires_at IS NULL OR expires_at > ?)",
    ),
    findByUserCode: database.prepare(
      "SELECT payload, consumed_at FROM records WHERE model = ? AND user_code = ? AND (expires_at IS NULL OR expires_at > ?)",
    ),
    removeAll: database.prepare("DELETE FROM records"),
    removeExpired: database.prepare(
      "DELETE FROM records WHERE rowid IN (SELECT rowid FROM records WHERE expires_at <= ? LIMIT ?)",
    ),
    revokeByGrantId: database.prepare("DELETE FROM records WHERE grant_id = ?"),
    upsert: database.prepare(`
      INSERT INTO records (model, id, payload, grant_id, user_code, uid, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (model, id) DO UPDATE SET
        payload = excluded.payload,
        grant_id = excluded.grant_id,
        user_code = excluded.user_code,
        uid = excluded.uid,
        expires_at = excluded.expires_at,
        consumed_at = NULL
    `),
  };

  function adapter(model: string): Adapter {
    return {
      consume: (id) => {
        statements.consume.run(Math.floor(now() / 1000), model, id);
        return Promise.resolve();
      },
      destroy: (id) => {
        statements.destroy.run(model, id);
        return Promise.resolve();
      },
      find: (id) => Promise.resolve(toPayload(statements.find.get(model, id, now()))),
      findByUid: (uid) => Promise.resolve(toPayload(statements.findByUid.get(model, uid, now()))),
      findByUserCode: (userCode) =>
        Promise.resolve(toPayload(statements.findByUserCode.get(model, userCode, now()))),
      // A grant's tokens are in other models' records, so revoking a grant
      // deletes across every model.
      revokeByGrantId: (grantId) => {
        statements.revokeByGrantId.run(grantId);
        return Promise.resolve();
      },
      upsert: (id, payload, expiresIn) => {
        // Stryker disable next-line ConditionalExpression: without the check, the sum is NaN,
        // which SQLite also stores as NULL. The check says what's meant.
        const expiresAt = expiresIn === undefined ? null : now() + expiresIn * 1000;
        statements.upsert.run(
          model,
          id,
          JSON.stringify(payload),
          payload.grantId ?? null,
          payload.userCode ?? null,
          payload.uid ?? null,
          expiresAt,
        );
        return Promise.resolve();
      },
    };
  }

  return {
    adapter,
    backUp: async (destination) => {
      try {
        closeSync(openSync(destination, "wx", databaseFileMode));
        await backup(database, destination);
      } catch (error) {
        return { ok: false, errors: [`could not back up to ${destination} (${errorCode(error)})`] };
      }
      return { ok: true, value: undefined };
    },
    removeAll: () => Number(statements.removeAll.run().changes),
    removeExpired: (limit) => Number(statements.removeExpired.run(now(), limit).changes),
    [Symbol.dispose]: () => database.close(),
  };
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  // Stryker disable next-line OptionalChaining: PRAGMA user_version always returns a row.
  return Number(row?.["user_version"]);
}

// The payload column holds what upsert wrote, which oidc-provider built and
// checks again when it loads a model, so it only needs to be an object here.
const StoredPayload = z.record(z.string(), z.unknown());

function toPayload(row: Record<string, unknown> | undefined): AdapterPayload | undefined {
  if (row === undefined) {
    return undefined;
  }
  const payload: AdapterPayload = StoredPayload.parse(JSON.parse(String(row["payload"])));
  const consumedAt = row["consumed_at"];
  return typeof consumedAt === "number" ? { ...payload, consumed: consumedAt } : payload;
}

// Create the file with owner-only permissions before SQLite opens it, so it
// is never readable by others, even for a moment. An existing file must
// already be owner-only.
function prepareFile(path: string): string | undefined {
  try {
    closeSync(openSync(path, "a", databaseFileMode));
    const { mode } = statSync(path);
    if ((mode & groupAndOtherPermissions) !== 0) {
      return `DATA_DIR: ${path} must be readable only by its owner (mode 600)`;
    }
  } catch (error) {
    return `DATA_DIR: could not open ${path} (${errorCode(error)})`;
  }
  return undefined;
}

export type ScheduleRemovalOptions = {
  /** The most records one run deletes, so a backlog can't stall the broker. */
  readonly batchSize: number;
  readonly database: Pick<ProviderDatabase, "removeExpired">;
  readonly intervalMs: number;
  readonly log: (entry: {
    readonly level: "info";
    readonly message: string;
    readonly removed: number;
  }) => void;
};

/**
 * Remove expired records on a timer. A run that fills its batch is logged,
 * since a steady backlog means the interval or batch is too small. Disposing
 * the result stops the timer.
 */
export function scheduleRemoval(options: ScheduleRemovalOptions): Disposable {
  const timer = setInterval(() => {
    const removed = options.database.removeExpired(options.batchSize);
    if (removed === options.batchSize) {
      options.log({ level: "info", message: "Removed a full batch of expired records", removed });
    }
  }, options.intervalMs);
  // The timer alone mustn't keep the process running at shutdown.
  timer.unref();
  return { [Symbol.dispose]: () => clearInterval(timer) };
}
