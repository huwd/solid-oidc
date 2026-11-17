import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("accepts a minimal https issuer and applies defaults", () => {
    const result = parseConfig({ ISSUER_URL: "https://id.example.test" });

    assert.ok(result.ok, "expected a valid configuration");
    assert.equal(result.config.issuer, "https://id.example.test");
    assert.equal(result.config.host, "0.0.0.0");
    assert.equal(result.config.port, 3000);
  });

  it("keeps an issuer path without adding a trailing slash", () => {
    const result = parseConfig({ ISSUER_URL: "https://example.test/solid" });

    assert.ok(result.ok, "expected a valid configuration");
    assert.equal(result.config.issuer, "https://example.test/solid");
  });

  it("reads HOST and PORT", () => {
    const result = parseConfig({
      HOST: "127.0.0.1",
      ISSUER_URL: "https://id.example.test",
      PORT: "8080",
    });

    assert.ok(result.ok, "expected a valid configuration");
    assert.equal(result.config.host, "127.0.0.1");
    assert.equal(result.config.port, 8080);
  });

  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    it(`allows plain http on the loopback host ${hostname}`, () => {
      const result = parseConfig({ ISSUER_URL: `http://${hostname}:3000/solid` });

      assert.ok(result.ok, `expected http://${hostname} to be accepted`);
    });
  }

  it("requires ISSUER_URL", () => {
    const result = parseConfig({});

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /^ISSUER_URL: /);
  });

  it("rejects a value that is not a URL", () => {
    const result = parseConfig({ ISSUER_URL: "not a url" });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.match(result.errors[0] ?? "", /^ISSUER_URL: /);
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
      const result = parseConfig({ ISSUER_URL: issuer });

      assert.ok(!result.ok, `expected ${issuer} to be rejected`);
      assert.ok(
        result.errors.includes(`ISSUER_URL: ${message}`),
        `expected "${message}" in ${JSON.stringify(result.errors)}`,
      );
    });
  }

  for (const port of ["-1", "65536", "80.5", "eighty"]) {
    it(`rejects the port ${port}`, () => {
      const result = parseConfig({ ISSUER_URL: "https://id.example.test", PORT: port });

      assert.ok(!result.ok, `expected PORT=${port} to be rejected`);
      assert.match(result.errors[0] ?? "", /^PORT: /);
    });
  }

  it("rejects an empty HOST", () => {
    const result = parseConfig({ HOST: "", ISSUER_URL: "https://id.example.test" });

    assert.ok(!result.ok, "expected an empty HOST to be rejected");
    assert.match(result.errors[0] ?? "", /^HOST: /);
  });

  it("reports every problem at once", () => {
    const result = parseConfig({ ISSUER_URL: "http://id.example.test?a#b", PORT: "-1" });

    assert.ok(!result.ok, "expected the configuration to be rejected");
    assert.equal(result.errors.length, 3, JSON.stringify(result.errors));
  });
});
