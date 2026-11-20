import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cookieKeyRetireWaitMs,
  describeKeys,
  promote,
  publishWaitMs,
  retire,
  rotate,
  signingKeyRetireWaitMs,
} from "./key-rotation.ts";
import { type KeyFile, keysMax, newKeyFile } from "./keys.ts";

const start = Date.parse("2026-03-01T09:00:00.000Z");
const minute = 60_000;

function ok(step: ReturnType<typeof rotate>): KeyFile {
  assert.ok(step.ok, `expected the step to succeed: ${JSON.stringify(step)}`);
  return step.value.file;
}

function errors(step: ReturnType<typeof rotate>): readonly string[] {
  assert.ok(!step.ok, "expected the step to be refused");
  return step.errors;
}

const kids = (file: KeyFile) => file.signingKeys.map((key) => key.jwk.kid);
const cookies = (file: KeyFile) => file.cookieKeys.map((key) => key.key);

describe("the waits", () => {
  it("cover the token lifetime, clock tolerance and session lifetime", () => {
    assert.equal(publishWaitMs, 10 * minute);
    assert.equal(signingKeyRetireWaitMs, 65 * minute);
    assert.equal(cookieKeyRetireWaitMs, 14 * 24 * 60 * minute);
  });
});

describe("rotate", () => {
  it("publishes a new signing key last, and puts a new cookie key first", () => {
    const original = newKeyFile(start);

    const step = rotate(original, { now: start + minute });
    const rotated = ok(step);

    assert.deepEqual(kids(rotated).slice(0, 1), kids(original), "the old key keeps signing");
    assert.equal(rotated.signingKeys.length, 2);
    assert.equal(rotated.signingKeys[1]?.promotedAt, null);
    assert.equal(rotated.signingKeys[1]?.addedAt, "2026-03-01T09:01:00.000Z");
    assert.deepEqual(cookies(rotated).slice(1), cookies(original), "old cookie keys still verify");
    assert.equal(rotated.cookieKeys.length, 2);
    assert.ok(step.ok);
    assert.match(step.value.changes[0] ?? "", /Promote it from 2026-03-01T09:11:00\.000Z\.$/);
  });

  it("refuses while a new signing key is still waiting", () => {
    const rotated = ok(rotate(newKeyFile(start), { now: start }));

    assert.deepEqual(errors(rotate(rotated, { now: start })), [
      "A new signing key is already waiting to start signing. Promote it first.",
    ]);
  });

  it("refuses when the file holds as many keys as it can", () => {
    let file = newKeyFile(start);
    for (let index = 1; index < keysMax; index += 1) {
      file = ok(promote(ok(rotate(file, { now: start })), { now: start, skipWait: true }));
    }

    assert.equal(file.signingKeys.length, keysMax);
    assert.deepEqual(errors(rotate(file, { now: start })), [
      `The key file already holds ${keysMax} keys of one kind. Retire old keys first.`,
    ]);
  });
});

describe("promote", () => {
  it("refuses until the new key has been published for the wait", () => {
    const rotated = ok(rotate(newKeyFile(start), { now: start }));

    const [error] = errors(promote(rotated, { now: start + publishWaitMs - 1 }));

    assert.match(
      error ?? "",
      /Solid servers may not have seen it yet\. Promote it from 2026-03-01T09:10:00\.000Z\.$/,
    );
  });

  it("moves the new key first after the wait, so it signs, and keeps the old one published", () => {
    const original = newKeyFile(start);
    const rotated = ok(rotate(original, { now: start }));
    const [, added] = kids(rotated);

    const step = promote(rotated, { now: start + publishWaitMs });
    const promoted = ok(step);

    assert.deepEqual(kids(promoted), [added, ...kids(original)]);
    assert.equal(promoted.signingKeys[0]?.promotedAt, "2026-03-01T09:10:00.000Z");
    assert.ok(step.ok);
    assert.match(
      step.value.changes[0] ?? "",
      /Retire older signing keys from 2026-03-01T10:15:00\.000Z\.$/,
    );
  });

  it("promotes before the wait when told to skip it", () => {
    const rotated = ok(rotate(newKeyFile(start), { now: start }));

    const promoted = ok(promote(rotated, { now: start, skipWait: true }));

    assert.equal(promoted.signingKeys[0]?.jwk.kid, rotated.signingKeys[1]?.jwk.kid);
  });

  it("refuses when no key is waiting", () => {
    assert.deepEqual(errors(promote(newKeyFile(start), { now: start })), [
      "No signing key is waiting to start signing. Rotate first.",
    ]);
  });
});

describe("retire", () => {
  function rotatedAndPromoted() {
    const rotated = ok(rotate(newKeyFile(start), { now: start }));
    const promotedAt = start + publishWaitMs;
    return { file: ok(promote(rotated, { now: promotedAt })), promotedAt };
  }

  it("refuses while every old key may still be in use, saying when each can go", () => {
    const { file, promotedAt } = rotatedAndPromoted();

    assert.deepEqual(errors(retire(file, { now: promotedAt + signingKeyRetireWaitMs - 1 })), [
      "Old signing keys may still verify tokens. Retire them from 2026-03-01T10:15:00.000Z.",
      "Old cookie keys may still verify sessions. Retire them from 2026-03-15T09:00:00.000Z.",
    ]);
  });

  it("removes old signing keys once their tokens have expired, and keeps old cookie keys", () => {
    const { file, promotedAt } = rotatedAndPromoted();

    const step = retire(file, { now: promotedAt + signingKeyRetireWaitMs });
    const retired = ok(step);

    assert.deepEqual(kids(retired), kids(file).slice(0, 1));
    assert.deepEqual(cookies(retired), cookies(file));
    assert.ok(step.ok);
    assert.deepEqual(step.value.changes, [
      `Retired signing key ${file.signingKeys[1]?.jwk.kid}.`,
      "Old cookie keys may still verify sessions. Retire them from 2026-03-15T09:00:00.000Z.",
    ]);
  });

  it("removes old cookie keys once their sessions have expired", () => {
    const { file } = rotatedAndPromoted();
    const signingRetired = ok(retire(file, { now: start + 2 * 60 * minute }));

    const step = retire(signingRetired, { now: start + cookieKeyRetireWaitMs });
    const retired = ok(step);

    assert.deepEqual(cookies(retired), cookies(file).slice(0, 1));
    assert.ok(step.ok);
    assert.deepEqual(step.value.changes, ["Retired 1 cookie key."]);
  });

  it("counts several old cookie keys", () => {
    const twice = ok(
      rotate(
        ok(promote(ok(rotate(newKeyFile(start), { now: start })), { now: start, skipWait: true })),
        { now: start },
      ),
    );

    const step = retire(twice, { now: start, skipWait: true });

    assert.ok(step.ok);
    assert.ok(step.value.changes.includes("Retired 2 cookie keys."));
  });

  it("removes every old key before the wait when told to skip it, but keeps a waiting key", () => {
    const { file } = rotatedAndPromoted();
    const waiting = ok(rotate(file, { now: start + publishWaitMs }));

    const retired = ok(retire(waiting, { now: start + publishWaitMs, skipWait: true }));

    assert.deepEqual(kids(retired), [kids(waiting)[0], kids(waiting)[2]]);
    assert.equal(retired.cookieKeys.length, 1);
  });

  it("finds nothing to retire in a file with no keys", () => {
    assert.deepEqual(errors(retire({ cookieKeys: [], signingKeys: [] }, { now: start })), [
      "There are no old keys to retire.",
    ]);
  });

  it("refuses when there are no old keys", () => {
    assert.deepEqual(errors(retire(newKeyFile(start), { now: start })), [
      "There are no old keys to retire.",
    ]);
  });

  it("keeps a waiting signing key when it is the only other key", () => {
    const rotated = ok(rotate(newKeyFile(start), { now: start }));

    const step = retire(rotated, { now: start, skipWait: true });
    const retired = ok(step);

    assert.deepEqual(kids(retired), kids(rotated));
    assert.equal(retired.cookieKeys.length, 1);
  });
});

describe("describeKeys", () => {
  it("says what each key does", () => {
    const original = newKeyFile(start);
    const promoted = ok(
      promote(ok(rotate(original, { now: start })), { now: start + publishWaitMs }),
    );
    const waiting = ok(rotate(promoted, { now: start + 20 * minute }));
    const [first, second, third] = kids(waiting);

    assert.deepEqual(describeKeys(waiting), [
      `Signing key ${first}: signs tokens, since 2026-03-01T09:10:00.000Z`,
      `Signing key ${second}: published, stopped signing`,
      `Signing key ${third}: published, waiting to sign, since 2026-03-01T09:20:00.000Z`,
      "Cookie key 1: added 2026-03-01T09:20:00.000Z, signs cookies",
      "Cookie key 2: added 2026-03-01T09:00:00.000Z, verifies only",
      "Cookie key 3: added 2026-03-01T09:00:00.000Z, verifies only",
    ]);
  });
});
