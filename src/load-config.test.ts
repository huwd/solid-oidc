import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Environment } from "./config.ts";
import { loadConfig, type ReadTextFile } from "./load-config.ts";

const accountsPath = "/config/accounts.json";
const secretPath = "/run/secrets/upstream";
const upstreamIssuer = "https://auth.example.test";

const environment: Environment = {
  ACCOUNTS_FILE: accountsPath,
  DATA_DIR: "/data",
  ISSUER_URL: "https://id.example.test",
  UPSTREAM_CLIENT_ID: "solid-oidc",
  UPSTREAM_CLIENT_SECRET_FILE: secretPath,
  UPSTREAM_ISSUER_URL: upstreamIssuer,
};

const accountsJson = JSON.stringify({
  accounts: [
    {
      upstreamIssuer,
      upstreamSubject: "8c1f6d2e-alice",
      webId: "https://alice.example.test/profile#me",
    },
  ],
});

class FileSystemError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`${code}: file system error`);
    this.code = code;
  }
}

// An in-memory file system: paths it doesn't know fail like a missing file.
function readerFor(files: Readonly<Record<string, string>>): ReadTextFile {
  return (path) => {
    const text = files[path];
    return text === undefined
      ? Promise.reject(new FileSystemError("ENOENT"))
      : Promise.resolve(text);
  };
}

describe("loadConfig", () => {
  it("loads the environment, the secret file and the accounts file", async () => {
    const result = await loadConfig({
      environment,
      readTextFile: readerFor({ [accountsPath]: accountsJson, [secretPath]: "s3cret\n" }),
    });

    assert.ok(result.ok, "expected a valid configuration");
    assert.equal(result.value.issuer, "https://id.example.test");
    assert.equal(result.value.dataDir, "/data");
    assert.equal(result.value.upstream.clientSecret, "s3cret");
    assert.equal(
      await result.value.accounts.findWebId({ issuer: upstreamIssuer, subject: "8c1f6d2e-alice" }),
      "https://alice.example.test/profile#me",
    );
  });

  it("uses UPSTREAM_CLIENT_SECRET directly when no secret file is named", async () => {
    const result = await loadConfig({
      environment: {
        ...environment,
        UPSTREAM_CLIENT_SECRET: "from-env",
        UPSTREAM_CLIENT_SECRET_FILE: undefined,
      },
      readTextFile: readerFor({ [accountsPath]: accountsJson }),
    });

    assert.ok(result.ok, "expected a valid configuration");
    assert.equal(result.value.upstream.clientSecret, "from-env");
  });

  it("strips one trailing CRLF from the secret file and keeps other whitespace", async () => {
    const result = await loadConfig({
      environment,
      readTextFile: readerFor({ [accountsPath]: accountsJson, [secretPath]: " s3cret \r\n" }),
    });

    assert.ok(result.ok, "expected a valid configuration");
    assert.equal(result.value.upstream.clientSecret, " s3cret ");
  });

  it("returns environment errors without reading any file", async () => {
    const result = await loadConfig({
      environment: { ...environment, DATA_DIR: "data" },
      readTextFile: () => assert.fail("no file should be read"),
    });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.deepEqual(result.errors, ["DATA_DIR: must be an absolute path"]);
  });

  it("reports files that cannot be read, with the error code", async () => {
    const result = await loadConfig({ environment, readTextFile: readerFor({}) });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.deepEqual(result.errors, [
      `UPSTREAM_CLIENT_SECRET_FILE: could not read ${secretPath} (ENOENT)`,
      `ACCOUNTS_FILE: could not read ${accountsPath} (ENOENT)`,
    ]);
  });

  it("reports a read failure without a code as an unknown error", async () => {
    const result = await loadConfig({
      environment,
      readTextFile: () => Promise.reject(new Error("unexpected")),
    });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.ok(
      result.errors.includes(`ACCOUNTS_FILE: could not read ${accountsPath} (unknown error)`),
      JSON.stringify(result.errors),
    );
  });

  it("rejects an empty secret file", async () => {
    const result = await loadConfig({
      environment,
      readTextFile: readerFor({ [accountsPath]: accountsJson, [secretPath]: "\n" }),
    });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.deepEqual(result.errors, [`UPSTREAM_CLIENT_SECRET_FILE: ${secretPath} is empty`]);
  });

  it("prefixes accounts file problems with ACCOUNTS_FILE", async () => {
    const result = await loadConfig({
      environment,
      readTextFile: readerFor({ [accountsPath]: "{}", [secretPath]: "s3cret" }),
    });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.match(result.errors[0] ?? "", /^ACCOUNTS_FILE: accounts: /);
  });

  it("never includes the client secret in an error", async () => {
    const secret = "do-not-print-me";
    const result = await loadConfig({
      environment: {
        ...environment,
        UPSTREAM_CLIENT_SECRET: secret,
        UPSTREAM_CLIENT_SECRET_FILE: undefined,
      },
      readTextFile: readerFor({ [accountsPath]: "not json" }),
    });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.ok(
      result.errors.every((error) => !error.includes(secret)),
      "expected no error to contain the secret",
    );
  });
});
