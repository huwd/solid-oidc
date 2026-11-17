import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type Account, createStaticAccountStore, parseAccounts } from "./accounts.ts";

const upstreamIssuer = "https://auth.example.test";

const alice: Account = {
  upstreamIssuer,
  upstreamSubject: "8c1f6d2e-alice",
  webId: "https://alice.example.test/profile#me",
};

function accountsText(accounts: readonly unknown[]): string {
  return JSON.stringify({ accounts });
}

function errorsFor(text: string): readonly string[] {
  const result = parseAccounts({ text, upstreamIssuer });
  assert.ok(!result.ok, "expected the accounts file to be rejected");
  return result.errors;
}

describe("parseAccounts", () => {
  it("accepts a valid accounts file", () => {
    const result = parseAccounts({ text: accountsText([alice]), upstreamIssuer });

    assert.ok(result.ok, "expected a valid accounts file");
    assert.deepEqual(result.value, [alice]);
  });

  it("allows two upstream accounts to share a WebID", () => {
    const second = { ...alice, upstreamSubject: "4b2a-alice-second-device" };

    const result = parseAccounts({ text: accountsText([alice, second]), upstreamIssuer });

    assert.ok(result.ok, "expected two subjects for one WebID to be accepted");
  });

  it("allows a loopback http WebID for development", () => {
    const local = { ...alice, webId: "http://localhost:3001/profile#me" };

    const result = parseAccounts({ text: accountsText([local]), upstreamIssuer });

    assert.ok(result.ok, "expected a loopback WebID to be accepted");
  });

  it("rejects text that is not JSON without quoting it", () => {
    const errors = errorsFor('{"accounts": [secret');

    assert.deepEqual(errors, ["is not valid JSON"]);
  });

  it("rejects a file with no accounts", () => {
    const errors = errorsFor(accountsText([]));

    assert.match(errors[0] ?? "", /^accounts: /);
  });

  it("rejects more than 1,000 accounts", () => {
    const accounts = Array.from({ length: 1_001 }, (_, index) => ({
      ...alice,
      upstreamSubject: `subject-${index}`,
    }));

    const errors = errorsFor(accountsText(accounts));

    assert.match(errors[0] ?? "", /^accounts: /);
  });

  it("rejects unknown keys, so a misspelt field is not silently ignored", () => {
    const errors = errorsFor(JSON.stringify({ accounts: [{ ...alice, webid: alice.webId }] }));

    assert.match(errors[0] ?? "", /^accounts\.0: /);
  });

  it("rejects unknown top-level keys", () => {
    const errors = errorsFor(JSON.stringify({ accounts: [alice], users: [] }));

    assert.match(errors[0] ?? "", /^: /);
  });

  for (const field of ["upstreamIssuer", "upstreamSubject", "webId"]) {
    it(`rejects an entry without ${field}`, () => {
      const errors = errorsFor(accountsText([{ ...alice, [field]: undefined }]));

      assert.match(errors[0] ?? "", new RegExp(`^accounts\\.0\\.${field}: `));
    });

    it(`rejects an entry with an empty ${field}`, () => {
      const errors = errorsFor(accountsText([{ ...alice, [field]: "" }]));

      assert.match(errors[0] ?? "", new RegExp(`^accounts\\.0\\.${field}: `));
    });
  }

  const invalidWebIds: ReadonlyArray<{ webId: string; message: string }> = [
    {
      webId: "http://alice.example.test/profile#me",
      message: "must use https, except on a loopback host",
    },
    {
      webId: "https://user:pw@alice.example.test/profile#me",
      message: "must not contain credentials",
    },
  ];
  for (const { webId, message } of invalidWebIds) {
    it(`rejects the WebID ${webId}`, () => {
      const errors = errorsFor(accountsText([{ ...alice, webId }]));

      assert.deepEqual(errors, [`accounts.0.webId: ${message}`]);
    });
  }

  it("rejects a WebID that is not a URL", () => {
    const errors = errorsFor(accountsText([{ ...alice, webId: "alice" }]));

    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0] ?? "", /^accounts\.0\.webId: /);
  });

  it("rejects an entry for a different upstream issuer", () => {
    const other = { ...alice, upstreamIssuer: "https://other.example.test" };

    const errors = errorsFor(accountsText([other]));

    assert.deepEqual(errors, [
      `accounts.0.upstreamIssuer: must equal UPSTREAM_ISSUER_URL (${upstreamIssuer})`,
    ]);
  });

  it("compares the upstream issuer exactly, including a trailing slash", () => {
    const slashed = { ...alice, upstreamIssuer: `${upstreamIssuer}/` };

    const errors = errorsFor(accountsText([slashed]));

    assert.match(errors[0] ?? "", /^accounts\.0\.upstreamIssuer: must equal/);
  });

  it("rejects a duplicate issuer and subject pair", () => {
    const duplicate = { ...alice, webId: "https://mallory.example.test/profile#me" };

    const errors = errorsFor(accountsText([alice, duplicate]));

    assert.deepEqual(errors, [
      "accounts.1: duplicates an earlier entry with the same upstreamIssuer and upstreamSubject",
    ]);
  });
});

describe("createStaticAccountStore", () => {
  const store = createStaticAccountStore([alice]);

  it("finds the WebID for an exact issuer and subject", async () => {
    const webId = await store.findWebId({ issuer: upstreamIssuer, subject: alice.upstreamSubject });

    assert.equal(webId, alice.webId);
  });

  it("refuses a subject that is not mapped", async () => {
    const webId = await store.findWebId({ issuer: upstreamIssuer, subject: "unknown" });

    assert.equal(webId, undefined);
  });

  for (const subject of ["8c1f6d2e-ALICE", "8c1f6d2e-alice ", "8c1f6d2e-alic"]) {
    it(`refuses the near-miss subject ${JSON.stringify(subject)}`, async () => {
      const webId = await store.findWebId({ issuer: upstreamIssuer, subject });

      assert.equal(webId, undefined);
    });
  }

  it("refuses the same subject from a different issuer", async () => {
    const webId = await store.findWebId({
      issuer: "https://other.example.test",
      subject: alice.upstreamSubject,
    });

    assert.equal(webId, undefined);
  });

  it("keeps accounts from different issuers apart", async () => {
    const otherIssuer = "https://other.example.test";
    const bob: Account = {
      upstreamIssuer: otherIssuer,
      upstreamSubject: alice.upstreamSubject,
      webId: "https://bob.example.test/profile#me",
    };
    const twoIssuers = createStaticAccountStore([alice, bob]);

    const webIds = await Promise.all([
      twoIssuers.findWebId({ issuer: upstreamIssuer, subject: alice.upstreamSubject }),
      twoIssuers.findWebId({ issuer: otherIssuer, subject: alice.upstreamSubject }),
    ]);

    assert.deepEqual(webIds, [alice.webId, bob.webId]);
  });
});
