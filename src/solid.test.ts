import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  clientDocumentFetch,
  corsAllowedForClient,
  solidConfiguration,
  solidOidcSupported,
  solidResource,
} from "./solid.ts";
import {
  createClientDocuments,
  jsonLd,
  solidAppDocument,
} from "./test-support/client-documents.ts";
import {
  aliceWebId,
  appLogin,
  appOrigin,
  exchangeAtBroker,
  formAction,
  type Harness,
  startHarness,
  visitUntilPage,
} from "./test-support/login-harness.ts";
import { checkSignature, decodeJwt } from "./test-support/tokens.ts";

const clientId = `${appOrigin}/clientid.jsonld`;
const solidApp = { client_id: clientId, redirect_uris: [`${appOrigin}/callback`] } as const;

/** Log in with a Client ID Document app, through consent, to the app's callback. */
async function logInAsSolidApp(harness: Harness, extra: Record<string, string> = {}) {
  const login = await appLogin(harness, solidApp, {
    scope: "openid webid offline_access",
    ...extra,
  });
  const consent = await visitUntilPage(harness, login.authorizationUrl);
  const callback = await visitUntilPage(harness, formAction(consent, "Allow"), "POST");
  return { callback, consent, login };
}

// Check the token's signature against the broker's published keys, as a
// Solid server would.
async function assertSignedByBroker(harness: Harness, jwt: string): Promise<void> {
  assert.equal(await checkSignature(harness.issuer, jwt), "valid");
}

async function jwkThumbprint(publicKey: CryptoKey): Promise<string> {
  const { crv, kty, x, y } = await crypto.subtle.exportKey("jwk", publicKey);
  return createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
}

function servingSolidApp(overrides: Record<string, unknown> = {}) {
  const documents = createClientDocuments();
  documents.serve(clientId, () => jsonLd(solidAppDocument(clientId, overrides)));
  return documents;
}

describe("discovery", () => {
  it("advertises Solid-OIDC, the webid scope and DPoP", async () => {
    await using harness = await startHarness();

    const response = await fetch(`${harness.issuer}/.well-known/openid-configuration`);
    const discovery = (await response.json()) as Record<string, unknown>;

    assert.equal(discovery["solid_oidc_supported"], "https://solidproject.org/TR/solid-oidc");
    assert.equal(solidOidcSupported, discovery["solid_oidc_supported"]);
    assert.ok((discovery["scopes_supported"] as string[]).includes("webid"));
    assert.ok((discovery["claims_supported"] as string[]).includes("webid"));
    assert.ok(Array.isArray(discovery["dpop_signing_alg_values_supported"]));
  });
});

describe("tokens for a Solid app", () => {
  it("issues a DPoP-bound JWT access token carrying the WebID, client and audience", async () => {
    await using harness = await startHarness({ fetch: servingSolidApp().fetch });
    const { callback, login } = await logInAsSolidApp(harness);

    const { keyPair, tokens } = await exchangeAtBroker(harness, login, callback.url, { clientId });

    assert.equal(tokens.token_type.toLowerCase(), "dpop");
    const { payload } = decodeJwt(tokens.access_token);
    assert.equal(payload["webid"], aliceWebId);
    assert.equal(payload["client_id"], clientId);
    assert.deepEqual(payload["cnf"], { jkt: await jwkThumbprint(keyPair.publicKey) });
    const audience = [payload["aud"]].flat();
    assert.ok(
      audience.includes("solid"),
      `expected solid in the audience, got ${String(audience)}`,
    );
    await assertSignedByBroker(harness, tokens.access_token);
  });

  it("puts the WebID in the ID token", async () => {
    await using harness = await startHarness({ fetch: servingSolidApp().fetch });
    const { callback, login } = await logInAsSolidApp(harness);

    const { tokens } = await exchangeAtBroker(harness, login, callback.url, { clientId });

    const claims = tokens.claims();
    assert.equal(claims?.["webid"], aliceWebId);
    assert.equal(claims?.sub, aliceWebId);
  });

  it("refuses a token request without a DPoP proof", async () => {
    await using harness = await startHarness({ fetch: servingSolidApp().fetch });
    const { callback, login } = await logInAsSolidApp(harness);

    await assert.rejects(
      exchangeAtBroker(harness, login, callback.url, { clientId, dpop: false }),
      // oidc-provider hides the reason, "DPoP proof JWT not provided", behind
      // a generic invalid_grant. The same exchange with a proof succeeds in
      // the tests above.
      (error: Error & { error?: string }) => {
        assert.equal(error.error, "invalid_grant");
        return true;
      },
    );
  });

  it("refuses a resource other than Solid", async () => {
    await using harness = await startHarness({ fetch: servingSolidApp().fetch });
    const login = await appLogin(harness, solidApp, {
      resource: "https://elsewhere.example.test/",
      scope: "openid webid",
    });

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    assert.equal(visit.url.searchParams.get("error"), "invalid_target");
    assert.equal(
      visit.url.searchParams.get("error_description"),
      "the broker issues tokens only for Solid",
    );
  });
});

describe("cross-origin token requests", () => {
  // A code that was never issued: the endpoint refuses it after the CORS
  // check, so the error shows whether the origin got through.
  async function tokenRequestFrom(harness: Harness, origin: string) {
    return fetch(`${harness.issuer}/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code: "never-issued",
        grant_type: "authorization_code",
        redirect_uri: solidApp.redirect_uris[0],
      }),
      headers: { origin },
      method: "POST",
    });
  }

  it("lets the app's own origin call the token endpoint", async () => {
    await using harness = await startHarness({ fetch: servingSolidApp().fetch });

    const response = await tokenRequestFrom(harness, appOrigin);

    assert.equal(response.headers.get("access-control-allow-origin"), appOrigin);
    const body = (await response.json()) as { error: string };
    assert.notEqual(body.error, "invalid_request", "expected the origin to be allowed");
  });

  it("refuses the token endpoint to any other origin", async () => {
    await using harness = await startHarness({ fetch: servingSolidApp().fetch });

    const response = await tokenRequestFrom(harness, "https://elsewhere.example.test");

    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = (await response.json()) as { error: string; error_description: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.error_description, /origin https:\/\/elsewhere\.example\.test not allowed/);
  });
});

describe("Client ID Documents", () => {
  it("accepts a JSON-LD document, asks for JSON-LD, and names the app on the consent page", async () => {
    const documents = servingSolidApp();
    await using harness = await startHarness({ fetch: documents.fetch });

    const { consent } = await logInAsSolidApp(harness);

    assert.match(
      consent.body,
      /Solid Test App \(<code>https:\/\/app\.example\.test\/clientid\.jsonld<\/code>\)/,
    );
    assert.match(documents.requests[0]?.headers.get("accept") ?? "", /^application\/ld\+json/);
  });

  it("reuses a fetched document rather than fetching it for every login", async () => {
    const documents = servingSolidApp();
    await using harness = await startHarness({ fetch: documents.fetch });

    await logInAsSolidApp(harness);
    // The app already has a grant, so this login returns straight to it.
    const again = await appLogin(harness, solidApp, { scope: "openid webid offline_access" });
    const callback = await visitUntilPage(harness, again.authorizationUrl);

    assert.ok(callback.url.searchParams.has("code"), `expected a code, got ${callback.url.href}`);
    assert.equal(documents.requests.length, 1);
  });

  /** Start a login and expect the broker to refuse the client outright. */
  async function assertClientRefused(harness: Harness, id = clientId) {
    const login = await appLogin(harness, {
      client_id: id,
      redirect_uris: [`${appOrigin}/callback`],
    });

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    // An unknown client can't be trusted with a redirect, so the broker
    // shows the error itself.
    assert.equal(visit.status, 400, `expected the client to be refused, got ${visit.status}`);
    assert.notEqual(visit.url.origin, appOrigin);
    assert.match(visit.body, /invalid_client/);
  }

  it("refuses a document that names a different client_id", async () => {
    const documents = servingSolidApp({ client_id: `${appOrigin}/someone-else` });
    await using harness = await startHarness({ fetch: documents.fetch });

    await assertClientRefused(harness);
  });

  const refusedResponses: readonly (readonly [
    string,
    (request: Request) => Response | Promise<Response>,
  ])[] = [
    ["a missing document", () => new Response("not found", { status: 404 })],
    [
      "a redirect",
      () => new Response(null, { headers: { location: `${appOrigin}/elsewhere` }, status: 302 }),
    ],
    [
      "a body that isn't JSON",
      () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ],
    [
      "an oversized document",
      () => jsonLd(solidAppDocument(clientId, { padding: "x".repeat(6_000) })),
    ],
    [
      "a document that takes too long",
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    ],
  ];

  for (const [name, respond] of refusedResponses) {
    it(`refuses ${name}`, async () => {
      const documents = createClientDocuments();
      documents.serve(clientId, respond);
      await using harness = await startHarness({ fetch: documents.fetch });

      await assertClientRefused(harness);
    });
  }

  it("refuses a document that can't be reached", async () => {
    await using harness = await startHarness({ fetch: createClientDocuments().fetch });

    await assertClientRefused(harness);
  });

  it("never fetches a client_id that isn't an HTTPS URL", async () => {
    const documents = createClientDocuments();
    await using harness = await startHarness({ fetch: documents.fetch });

    await assertClientRefused(harness, "http://app.example.test/clientid.jsonld");

    assert.equal(documents.requests.length, 0);
  });

  it("never fetches a client_id on the broker's or the upstream provider's origin", async () => {
    const documents = createClientDocuments();
    await using harness = await startHarness({ fetch: documents.fetch });
    const impostors = [
      `https://${new URL(harness.issuer).host}/fake-client`,
      `https://${new URL(harness.upstream.issuer).host}/fake-client`,
    ];

    for (const impostor of impostors) {
      await assertClientRefused(harness, impostor);
    }

    assert.deepEqual(
      documents.requests.map((request) => request.url),
      [],
      "expected neither impostor to be fetched",
    );
  });
});

describe("solidConfiguration", () => {
  const configuration = solidConfiguration({
    allowLoopbackClientIds: false,
    fetch: globalThis.fetch,
    issuer: "https://id.example.test",
    upstreamIssuer: "https://auth.example.test",
  });

  it("adds the WebID only to access tokens", () => {
    const context = undefined as never;

    assert.deepEqual(
      configuration.extraTokenClaims(context, { accountId: aliceWebId, kind: "AccessToken" }),
      {
        webid: aliceWebId,
      },
    );
    assert.equal(configuration.extraTokenClaims(context, { kind: "ClientCredentials" }), undefined);
  });

  it("allows CORS only from the origins of the client's redirect URIs", () => {
    const context = undefined as never;
    const client = {
      redirectUris: [`${appOrigin}/callback`, "http://127.0.0.1:8080/callback", "not a URL"],
    };

    assert.equal(configuration.clientBasedCORS, corsAllowedForClient);
    assert.equal(corsAllowedForClient(context, appOrigin, client), true);
    assert.equal(corsAllowedForClient(context, "http://127.0.0.1:8080", client), true);
    assert.equal(corsAllowedForClient(context, "https://elsewhere.example.test", client), false);
    assert.equal(corsAllowedForClient(context, `${appOrigin}:8443`, client), false);
    assert.equal(corsAllowedForClient(context, "null", client), false);
    // A file: URL's origin is "null", so without the check it would match.
    assert.equal(new URL("file:///callback").origin, "null");
    assert.equal(
      corsAllowedForClient(context, "null", { redirectUris: ["file:///callback"] }),
      false,
    );
    assert.equal(corsAllowedForClient(context, appOrigin, {}), false);
  });

  it("describes the Solid resource", () => {
    const info = configuration.features.resourceIndicators.getResourceServerInfo(
      undefined as never,
      solidResource,
    );

    assert.equal(info.audience, "solid");
    assert.equal(info.accessTokenFormat, "jwt");
  });
});

describe("clientDocumentFetch", () => {
  it("keeps the other headers and options it is given", async () => {
    const documents = createClientDocuments();
    documents.serve(clientId, () => jsonLd({}));
    const signal = AbortSignal.timeout(1_000);

    await clientDocumentFetch({ allowLoopback: false, fetch: documents.fetch })(clientId, {
      headers: { "user-agent": "" },
      signal,
    });

    const [request] = documents.requests;
    assert.equal(request?.headers.get("user-agent"), "");
    assert.match(request?.headers.get("accept") ?? "", /application\/ld\+json/);
  });

  // oidc-provider's protection against private addresses is its dispatcher.
  // A Request can't carry one, so these record the options themselves.
  const dispatcher = { refuses: "private and loopback addresses" };

  async function dispatcherPassedFor(options: {
    readonly allowLoopback: boolean;
    readonly input: string | Request;
  }): Promise<unknown> {
    let passed: unknown = "not called";
    const recording: typeof globalThis.fetch = (_input, init) => {
      passed = (init as { readonly dispatcher?: unknown } | undefined)?.dispatcher;
      return Promise.resolve(new Response("{}"));
    };
    const init = { dispatcher } as unknown as RequestInit;
    await clientDocumentFetch({ allowLoopback: options.allowLoopback, fetch: recording })(
      options.input,
      init,
    );
    return passed;
  }

  it("keeps the protection for loopback when the development setting is off", async () => {
    const passed = await dispatcherPassedFor({
      allowLoopback: false,
      input: "https://localhost:5443/id",
    });

    assert.equal(passed, dispatcher);
  });

  it("drops the protection only for loopback hosts when the development setting is on", async () => {
    const results = await Promise.all(
      ["https://localhost:5443/id", "https://127.0.0.1/id", "https://[::1]/id"].map((input) =>
        dispatcherPassedFor({ allowLoopback: true, input }),
      ),
    );

    assert.deepEqual(results, [undefined, undefined, undefined]);
  });

  it("keeps the protection for every other host when the development setting is on", async () => {
    const results = await Promise.all(
      [
        "https://10.0.0.5/id",
        "https://app.example.test/id",
        "https://localhost.example.test/id",
      ].map((input) => dispatcherPassedFor({ allowLoopback: true, input })),
    );

    assert.deepEqual(results, [dispatcher, dispatcher, dispatcher]);
  });

  it("asks for JSON-LD when called with no options", async () => {
    const documents = createClientDocuments();
    documents.serve(clientId, () => jsonLd({}));

    await clientDocumentFetch({ allowLoopback: false, fetch: documents.fetch })(clientId);

    assert.match(documents.requests[0]?.headers.get("accept") ?? "", /application\/ld\+json/);
  });

  it("reads the host from a Request as well as a URL", async () => {
    const passed = await dispatcherPassedFor({
      allowLoopback: true,
      input: new Request("https://localhost:5443/id"),
    });

    assert.equal(passed, undefined);
  });
});
