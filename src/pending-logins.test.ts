import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPendingLogins } from "./pending-logins.ts";
import { newLoginChecks } from "./upstream.ts";

function clock(start = 1_000) {
  let now = start;
  return {
    advance(milliseconds: number) {
      now += milliseconds;
    },
    now: () => now,
  };
}

describe("createPendingLogins", () => {
  it("returns a login once, then forgets it", () => {
    const logins = createPendingLogins({ entriesMax: 10, now: clock().now, ttlMs: 1_000 });
    const checks = newLoginChecks();
    logins.put("uid-1", checks);

    assert.deepEqual(logins.take("uid-1"), checks);
    assert.equal(logins.take("uid-1"), undefined, "a login must not be taken twice");
  });

  it("forgets a login that has waited too long", () => {
    const time = clock();
    const logins = createPendingLogins({ entriesMax: 10, now: time.now, ttlMs: 1_000 });
    logins.put("uid-1", newLoginChecks());

    time.advance(1_000);

    assert.equal(logins.take("uid-1"), undefined);
  });

  it("replaces a login started again for the same interaction", () => {
    const logins = createPendingLogins({ entriesMax: 10, now: clock().now, ttlMs: 1_000 });
    logins.put("uid-1", newLoginChecks());
    const restarted = newLoginChecks();
    logins.put("uid-1", restarted);

    assert.deepEqual(logins.take("uid-1"), restarted);
  });

  it("drops the oldest login when full", () => {
    const logins = createPendingLogins({ entriesMax: 2, now: clock().now, ttlMs: 1_000 });
    logins.put("oldest", newLoginChecks());
    logins.put("middle", newLoginChecks());
    logins.put("newest", newLoginChecks());

    assert.equal(logins.take("oldest"), undefined);
    assert.ok(logins.take("middle"), "expected the middle login to be kept");
    assert.ok(logins.take("newest"), "expected the newest login to be kept");
  });

  it("moves a login started again to the back, as the newest", () => {
    const logins = createPendingLogins({ entriesMax: 3, now: clock().now, ttlMs: 1_000 });
    logins.put("first", newLoginChecks());
    logins.put("second", newLoginChecks());
    logins.put("first", newLoginChecks());
    logins.put("third", newLoginChecks());
    logins.put("fourth", newLoginChecks());

    assert.equal(logins.take("second"), undefined, "expected the oldest login to be dropped");
    assert.ok(logins.take("first"), "expected the restarted login to be kept");
    assert.ok(logins.take("third"), "expected the third login to be kept");
    assert.ok(logins.take("fourth"), "expected the newest login to be kept");
  });

  it("drops an expired login before a live one, since the oldest expires first", () => {
    const time = clock();
    const logins = createPendingLogins({ entriesMax: 2, now: time.now, ttlMs: 1_000 });
    logins.put("expired", newLoginChecks());
    time.advance(600);
    logins.put("live", newLoginChecks());
    time.advance(600);
    logins.put("newest", newLoginChecks());

    assert.ok(logins.take("live"), "expected the live login to survive");
    assert.ok(logins.take("newest"), "expected the newest login to be kept");
  });
});
