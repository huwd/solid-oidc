import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type Environment, parseEnvironment } from "./config.ts";

const validEnvironment: Environment = {
  ACCOUNTS_FILE: "/config/accounts.json",
  DATA_DIR: "/data",
  ISSUER_URL: "https://id.example.test",
  UPSTREAM_CLIENT_ID: "solid-oidc",
  UPSTREAM_CLIENT_SECRET: "client-secret",
  UPSTREAM_ISSUER_URL: "https://auth.example.test",
};

function environmentWith(overrides: Environment): Environment {
  return { ...validEnvironment, ...overrides };
}

function errorsFor(environment: Environment): readonly string[] {
  const result = parseEnvironment(environment);
  assert.ok(!result.ok, "expected the environment to be rejected");
  return result.errors;
}

describe("parseEnvironment", () => {
  it("accepts a minimal environment and applies defaults", () => {
    const result = parseEnvironment(validEnvironment);

    assert.ok(result.ok, "expected a valid environment");
    assert.deepEqual(result.value, {
      accountsFile: "/config/accounts.json",
      dataDir: "/data",
      host: "0.0.0.0",
      issuer: "https://id.example.test",
      port: 3000,
      upstream: {
        clientId: "solid-oidc",
        clientSecret: { kind: "value", value: "client-secret" },
        issuer: "https://auth.example.test",
      },
    });
  });

  it("reads HOST and PORT", () => {
    const result = parseEnvironment(environmentWith({ HOST: "127.0.0.1", PORT: "8080" }));

    assert.ok(result.ok, "expected a valid environment");
    assert.equal(result.value.host, "127.0.0.1");
    assert.equal(result.value.port, 8080);
  });

  it("reads the client secret from a file when UPSTREAM_CLIENT_SECRET_FILE is set", () => {
    const result = parseEnvironment(
      environmentWith({
        UPSTREAM_CLIENT_SECRET: undefined,
        UPSTREAM_CLIENT_SECRET_FILE: "/run/secrets/upstream",
      }),
    );

    assert.ok(result.ok, "expected a valid environment");
    assert.deepEqual(result.value.upstream.clientSecret, {
      kind: "file",
      path: "/run/secrets/upstream",
    });
  });

  it("rejects both UPSTREAM_CLIENT_SECRET and UPSTREAM_CLIENT_SECRET_FILE", () => {
    const errors = errorsFor(environmentWith({ UPSTREAM_CLIENT_SECRET_FILE: "/run/secrets/x" }));

    assert.deepEqual(errors, [
      "UPSTREAM_CLIENT_SECRET: set either UPSTREAM_CLIENT_SECRET or UPSTREAM_CLIENT_SECRET_FILE, not both",
    ]);
  });

  it("rejects neither UPSTREAM_CLIENT_SECRET nor UPSTREAM_CLIENT_SECRET_FILE", () => {
    const errors = errorsFor(environmentWith({ UPSTREAM_CLIENT_SECRET: undefined }));

    assert.deepEqual(errors, [
      "UPSTREAM_CLIENT_SECRET: set UPSTREAM_CLIENT_SECRET or UPSTREAM_CLIENT_SECRET_FILE",
    ]);
  });

  for (const name of ["UPSTREAM_CLIENT_SECRET", "UPSTREAM_CLIENT_SECRET_FILE"]) {
    it(`rejects an empty ${name}`, () => {
      const errors = errorsFor(environmentWith({ UPSTREAM_CLIENT_SECRET: undefined, [name]: "" }));

      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0] ?? "", new RegExp(`^${name}: `));
    });
  }

  for (const name of [
    "ACCOUNTS_FILE",
    "DATA_DIR",
    "ISSUER_URL",
    "UPSTREAM_CLIENT_ID",
    "UPSTREAM_ISSUER_URL",
  ]) {
    it(`requires ${name}`, () => {
      const errors = errorsFor(environmentWith({ [name]: undefined }));

      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0] ?? "", new RegExp(`^${name}: `));
    });
  }

  it("rejects a relative DATA_DIR", () => {
    const errors = errorsFor(environmentWith({ DATA_DIR: "data" }));

    assert.deepEqual(errors, ["DATA_DIR: must be an absolute path"]);
  });

  for (const port of ["-1", "65536", "80.5", "eighty"]) {
    it(`rejects the port ${port}`, () => {
      const errors = errorsFor(environmentWith({ PORT: port }));

      assert.match(errors[0] ?? "", /^PORT: /);
    });
  }

  it("rejects an empty HOST", () => {
    const errors = errorsFor(environmentWith({ HOST: "" }));

    assert.match(errors[0] ?? "", /^HOST: /);
  });

  it("reports every problem at once", () => {
    const errors = errorsFor({
      ISSUER_URL: "http://id.example.test?a#b",
      PORT: "-1",
    });

    // ISSUER_URL (2), PORT, the four other required variables, and the
    // missing client secret.
    assert.equal(errors.length, 8, JSON.stringify(errors));
  });
});

describe("ISSUER_URL", () => {
  it("keeps an issuer path without adding a trailing slash", () => {
    const result = parseEnvironment(environmentWith({ ISSUER_URL: "https://example.test/solid" }));

    assert.ok(result.ok, "expected a valid environment");
    assert.equal(result.value.issuer, "https://example.test/solid");
  });

  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    it(`allows plain http on the loopback host ${hostname}`, () => {
      const result = parseEnvironment(
        environmentWith({ ISSUER_URL: `http://${hostname}:3000/solid` }),
      );

      assert.ok(result.ok, `expected http://${hostname} to be accepted`);
    });
  }

  it("rejects a value that is not a URL", () => {
    const errors = errorsFor(environmentWith({ ISSUER_URL: "not a url" }));

    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0] ?? "", /^ISSUER_URL: /);
  });

  const invalidIssuers: ReadonlyArray<{ issuer: string; message: string }> = [
    { issuer: "http://id.example.test", message: "must use https, except on a loopback host" },
    { issuer: "ftp://id.example.test", message: "must use https, except on a loopback host" },
    { issuer: "https://id.example.test?tenant=a", message: "must not have a query or fragment" },
    { issuer: "https://id.example.test#me", message: "must not have a query or fragment" },
    { issuer: "https://id.example.test/", message: "must not end with a slash" },
    { issuer: "https://id.example.test/solid/", message: "must not end with a slash" },
    {
      issuer: "https://ID.Example.test",
      message: "must be written in canonical form: https://id.example.test",
    },
    {
      issuer: "https://id.example.test:443/solid",
      message: "must be written in canonical form: https://id.example.test/solid",
    },
    { issuer: "https://user:secret@id.example.test", message: "must not contain credentials" },
    { issuer: "https://user@id.example.test", message: "must not contain credentials" },
  ];
  for (const { issuer, message } of invalidIssuers) {
    it(`rejects the issuer ${issuer}`, () => {
      const errors = errorsFor(environmentWith({ ISSUER_URL: issuer }));

      assert.ok(
        errors.includes(`ISSUER_URL: ${message}`),
        `expected "${message}" in ${JSON.stringify(errors)}`,
      );
    });
  }
});

describe("UPSTREAM_ISSUER_URL", () => {
  // Some providers publish an issuer with a trailing slash, and the broker
  // must compare it exactly as published.
  for (const issuer of ["https://tenant.example.test/", "https://ID.Example.test:443/realm"]) {
    it(`keeps ${issuer} exactly as written`, () => {
      const result = parseEnvironment(environmentWith({ UPSTREAM_ISSUER_URL: issuer }));

      assert.ok(result.ok, `expected ${issuer} to be accepted`);
      assert.equal(result.value.upstream.issuer, issuer);
    });
  }

  it("rejects a value that is not a URL", () => {
    const errors = errorsFor(environmentWith({ UPSTREAM_ISSUER_URL: "not a url" }));

    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0] ?? "", /^UPSTREAM_ISSUER_URL: /);
  });

  const invalidIssuers: ReadonlyArray<{ issuer: string; message: string }> = [
    { issuer: "http://auth.example.test", message: "must use https, except on a loopback host" },
    { issuer: "https://auth.example.test?a=b", message: "must not have a query or fragment" },
    { issuer: "https://user:secret@auth.example.test", message: "must not contain credentials" },
  ];
  for (const { issuer, message } of invalidIssuers) {
    it(`rejects the upstream issuer ${issuer}`, () => {
      const errors = errorsFor(environmentWith({ UPSTREAM_ISSUER_URL: issuer }));

      assert.deepEqual(errors, [`UPSTREAM_ISSUER_URL: ${message}`]);
    });
  }
});
