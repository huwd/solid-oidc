import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, it } from "node:test";
import type Koa from "koa";

import { createStaticAccountStore } from "./accounts.ts";
import { pageHeaders } from "./pages.ts";
import {
  accountFinder,
  interactionUrl,
  interactionUrlFor,
  issuerPath,
  renderError,
} from "./provider.ts";
import { type RunningServer, startServer } from "./server.ts";
import { createTestBrokerApp, testBrokerKeys as keys } from "./test-support/broker-app.ts";

async function startBroker(issuer: string): Promise<RunningServer> {
  return startServer({ app: createTestBrokerApp(issuer), host: "127.0.0.1", port: 0 });
}

type Discovery = { issuer: string; jwks_uri: string; authorization_endpoint: string };

async function fetchDiscovery(options: { port: number; path: string }): Promise<Discovery> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`);
  assert.equal(response.status, 200, `expected discovery at ${options.path}`);
  return (await response.json()) as Discovery;
}

// fetch refuses to set Host, so spoofed headers go through node:http.
function getWithHeaders(options: {
  headers: Record<string, string>;
  path: string;
  port: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { headers: options.headers, host: "127.0.0.1", path: options.path, port: options.port },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("provider at a bare-origin issuer", () => {
  const issuer = "https://id.example.test";

  it("publishes discovery with the issuer exactly as configured", async () => {
    await using server = await startBroker(issuer);

    const discovery = await fetchDiscovery({
      path: "/.well-known/openid-configuration",
      port: server.port,
    });

    assert.equal(discovery.issuer, issuer);
    assert.ok(
      discovery.authorization_endpoint.startsWith(`${issuer}/`),
      `expected endpoints under ${issuer}, got ${discovery.authorization_endpoint}`,
    );
  });

  it("publishes only the public part of the signing key", async () => {
    await using server = await startBroker(issuer);
    const discovery = await fetchDiscovery({
      path: "/.well-known/openid-configuration",
      port: server.port,
    });
    const jwksPath = new URL(discovery.jwks_uri).pathname;

    const response = await fetch(`http://127.0.0.1:${server.port}${jwksPath}`);
    const jwks = (await response.json()) as { keys: Record<string, unknown>[] };

    assert.equal(jwks.keys.length, 1);
    const [published] = jwks.keys;
    assert.equal(published?.["kid"], keys.signingKeys[0]?.kid);
    assert.equal(published?.["kty"], "EC");
    assert.equal(published?.["d"], undefined, "the private part must never be published");
  });

  it("builds endpoint URLs from the issuer, not from spoofed request headers", async () => {
    await using server = await startBroker(issuer);

    const body = await getWithHeaders({
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
      path: "/.well-known/openid-configuration",
      port: server.port,
    });

    assert.ok(!body.includes("attacker.example"), "expected no spoofed host in discovery");
    assert.ok(!body.includes("http://"), "expected no downgraded protocol in discovery");
  });

  it("keeps the health endpoint outside the provider", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);

    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

describe("provider at an issuer with a path", () => {
  const issuer = "https://example.test/solid";

  it("publishes discovery under the issuer's path", async () => {
    await using server = await startBroker(issuer);

    const discovery = await fetchDiscovery({
      path: "/solid/.well-known/openid-configuration",
      port: server.port,
    });

    assert.equal(discovery.issuer, issuer);
    assert.ok(
      discovery.jwks_uri.startsWith(`${issuer}/`),
      `expected the JWKS under ${issuer}, got ${discovery.jwks_uri}`,
    );
  });

  it("does not answer outside the issuer's path", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/.well-known/openid-configuration`,
    );
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });

  it("does not treat a path that only shares a prefix as the issuer's", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/solidarity/.well-known/openid-configuration`,
    );
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });

  // The provider is handed what follows the issuer's path, so a path outside
  // it must be refused before that, or it could reach a provider route.
  for (const path of [
    "/abcdef/.well-known/openid-configuration",
    "/solid.well-known/openid-configuration",
  ]) {
    it(`does not answer ${path}, outside the issuer's path, even though it ends like a provider route`, async () => {
      await using server = await startBroker(issuer);

      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      await response.body?.cancel();

      assert.equal(response.status, 404);
    });
  }

  it("passes a query string on the issuer path to the provider intact", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/solid/.well-known/openid-configuration?unused=1`,
    );
    const discovery = (await response.json()) as Discovery;

    assert.equal(discovery.issuer, issuer);
  });

  it("answers the issuer path with a query string without failing", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(`http://127.0.0.1:${server.port}/solid?unused=1`);
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });

  it("answers the issuer path itself through the provider", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(`http://127.0.0.1:${server.port}/solid`);
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });
});

describe("interaction routes without a login in progress", () => {
  it("says the login has expired", async () => {
    await using server = await startBroker("https://example.test/solid");

    const response = await fetch(`http://127.0.0.1:${server.port}/solid/interaction/abc123`);

    assert.equal(response.status, 400);
    assert.match(await response.text(), /This login has expired/);
  });
});

describe("accountFinder", () => {
  const webId = "https://alice.example.test/profile/card#me";
  const findAccount = accountFinder(
    createStaticAccountStore([
      { upstreamIssuer: "https://auth.example.test", upstreamSubject: "a", webId },
    ]),
  );

  it("loads a mapped WebID as an account whose subject and webid claim are the WebID", async () => {
    const account = await findAccount(undefined as never, webId);

    assert.equal(account?.accountId, webId);
    assert.deepEqual(await account?.claims("id_token", "openid", {}, []), {
      sub: webId,
      webid: webId,
    });
  });

  it("loads nothing for a WebID that is no longer mapped", async () => {
    const account = await findAccount(undefined as never, "https://mallory.example.test/#me");

    assert.equal(account, undefined);
  });
});

describe("provider pages", () => {
  const issuer = "https://id.example.test/solid";

  it("shows an error it can't send back to the app on the broker's own page", async () => {
    await using server = await startBroker(issuer);
    const query = new URLSearchParams({
      client_id: "https://app.example.test/id",
      redirect_uri: "https://app.example.test/callback",
      response_type: "code",
      scope: "openid",
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/solid/auth?${query}`);
    const body = await response.text();

    assert.equal(response.status, 400);
    for (const [name, value] of Object.entries(pageHeaders)) {
      assert.equal(response.headers.get(name), value, `expected the ${name} header`);
    }
    assert.ok(body.includes("The app&#39;s request was refused"), body);
    assert.match(body, /\(invalid_client: [^)]+\)/);
  });

  it("has no development login pages, even at a path the broker's routes don't take", async () => {
    await using server = await startBroker(issuer);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/solid/interaction/${"a".repeat(65)}`,
    );
    await response.body?.cancel();

    assert.equal(response.status, 404);
  });
});

describe("renderError", () => {
  it("shows the error code alone when there is no description", () => {
    const context = { body: "", set: () => undefined } as unknown as Koa.Context;

    renderError(context, { error: "invalid_request" });

    assert.match(String(context.body), /\(invalid_request\)/);
  });
});

describe("provider helpers", () => {
  it("puts interactions under the issuer's path", () => {
    assert.equal(interactionUrl({ prefix: "/solid", uid: "abc" }), "/solid/interaction/abc");
    assert.equal(interactionUrl({ prefix: "", uid: "abc" }), "/interaction/abc");
  });

  it("builds the provider's interaction URL setting from the issuer path", () => {
    const url = interactionUrlFor("/solid");

    assert.equal(url(undefined, { uid: "abc" }), "/solid/interaction/abc");
  });

  it("uses an empty path for a bare-origin issuer", () => {
    assert.equal(issuerPath("https://id.example.test"), "");
    assert.equal(issuerPath("https://example.test/solid"), "/solid");
  });
});
