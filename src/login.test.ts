import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { upstreamRedirectUri } from "./app.ts";
import { pageHeaders } from "./pages.ts";
import { createBrowser, type Visit } from "./test-support/browser.ts";
import {
  alice,
  aliceSubject,
  aliceWebId,
  appLogin,
  appOrigin,
  exchangeAtBroker,
  formAction,
  type Harness,
  startHarness,
  testApp,
  toApp,
  unnamedApp,
  visitUntilPage,
} from "./test-support/login-harness.ts";
import { listenOnLoopback } from "./test-support/loopback.ts";

/** Check a page the broker shows, including the headers that keep it out of caches and frames. */
function assertPage(visit: Visit, expected: { status: number; heading: string; message?: string }) {
  assert.equal(visit.status, expected.status, `expected ${expected.status}, got ${visit.status}`);
  for (const [name, value] of Object.entries(pageHeaders)) {
    assert.equal(visit.headers.get(name), value, `expected the ${name} header`);
  }
  assert.ok(visit.body.includes(expected.heading), `expected the heading ${expected.heading}`);
  if (expected.message !== undefined) {
    assert.ok(visit.body.includes(expected.message), `expected the message ${expected.message}`);
  }
}

const expiredPage = {
  heading: "This login has expired",
  message: "Go back to the app and start again.",
  status: 400,
};
const unavailableStepPage = {
  heading: "This page is not available",
  message: "Go back to the app and start again.",
  status: 400,
};

describe("logging in through the upstream provider", () => {
  it("ends with an ID token for the mapped WebID", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const consent = await visitUntilPage(harness, login.authorizationUrl);
    const callback = await visitUntilPage(harness, formAction(consent, "Allow"), "POST");
    const { tokens } = await exchangeAtBroker(harness, login, callback.url);

    const claims = tokens.claims();
    assert.equal(claims?.sub, aliceWebId);
    assert.equal(claims?.iss, harness.issuer);
    assert.equal(claims?.["email"], undefined, "expected no upstream claims to pass through");
  });

  it("logs the login and the app's consent, with no token or code", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const consent = await visitUntilPage(harness, login.authorizationUrl);
    const callback = await visitUntilPage(harness, formAction(consent, "Allow"), "POST");

    assert.deepEqual(harness.logs, [
      {
        level: "info",
        message: "Logged in",
        upstreamIssuer: harness.upstream.issuer,
        upstreamSubject: aliceSubject,
        webId: aliceWebId,
      },
      { clientId: testApp.client_id, level: "info", message: "App allowed", webId: aliceWebId },
    ]);
    const code = callback.url.searchParams.get("code") ?? "";
    assert.ok(code !== "" && !JSON.stringify(harness.logs).includes(code));
  });

  it("asks for consent naming the app and the WebID", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const consent = await visitUntilPage(harness, login.authorizationUrl);

    assertPage(consent, { heading: "wants to act as", status: 200 });
    assert.match(consent.body, /Test &lt;App&gt; \(<code>test-app<\/code>\)/);
    assert.ok(
      consent.body.includes(`<code>${aliceWebId}</code>`),
      "expected the WebID on the page",
    );
  });

  it("asks again before another app can use an existing session", async () => {
    await using harness = await startHarness();
    const first = await appLogin(harness);
    const consent = await visitUntilPage(harness, first.authorizationUrl);
    await visitUntilPage(harness, formAction(consent, "Allow"), "POST");

    const second = await appLogin(harness, unnamedApp);
    const page = await visitUntilPage(harness, second.authorizationUrl);

    assert.equal(page.status, 200);
    assert.match(page.body, /<code>unnamed-app<\/code> wants to act as/);
  });

  it("asks again when the same app wants more than it was granted", async () => {
    await using harness = await startHarness();
    const first = await appLogin(harness);
    const consent = await visitUntilPage(harness, first.authorizationUrl);
    await visitUntilPage(harness, formAction(consent, "Allow"), "POST");

    const wider = await appLogin(harness, testApp, {
      prompt: "consent",
      scope: "openid offline_access",
    });
    const page = await visitUntilPage(harness, wider.authorizationUrl);
    const callback = await visitUntilPage(harness, formAction(page, "Allow"), "POST");

    assert.equal(callback.url.origin, appOrigin);
    assert.ok(callback.url.searchParams.has("code"), `expected a code, got ${callback.url.href}`);
  });

  it("returns access_denied to the app when the person denies it", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const consent = await visitUntilPage(harness, login.authorizationUrl);

    const callback = await visitUntilPage(harness, formAction(consent, "Deny"), "POST");

    assert.equal(callback.url.searchParams.get("error"), "access_denied");
    assert.equal(callback.url.searchParams.get("error_description"), "The person declined.");
    assert.deepEqual(harness.logs.at(-1), {
      clientId: testApp.client_id,
      level: "info",
      message: "App denied",
      webId: aliceWebId,
    });
  });
});

describe("refusing a login", () => {
  async function assertRefused(harness: Harness, visit: Visit) {
    assertPage(visit, {
      heading: "You could not be logged in",
      message:
        "Go back to the app and try again. If this keeps happening, contact the administrator.",
      status: 403,
    });
    assert.ok(!visit.body.includes(aliceSubject), "the page must not reveal the subject");
    assert.ok(!visit.body.includes("webid") && !visit.body.includes("WebID"));
    return harness.logs;
  }

  it("refuses an upstream subject with no mapping", async () => {
    await using harness = await startHarness();
    harness.upstream.logInAs("ffffffff-0000-4000-8000-000000000bad");
    const login = await appLogin(harness);

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    const logs = await assertRefused(harness, visit);
    assert.deepEqual(logs.at(-1), {
      level: "info",
      message: "No account for upstream identity",
      upstreamIssuer: harness.upstream.issuer,
      upstreamSubject: "ffffffff-0000-4000-8000-000000000bad",
    });
  });

  it("refuses a known subject from another issuer", async () => {
    await using harness = await startHarness({
      accounts: () => [alice("https://other-upstream.example.test")],
    });
    const login = await appLogin(harness);

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    await assertRefused(harness, visit);
  });

  it("refuses a callback whose state was changed", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const visit = await harness.browser.visit(login.authorizationUrl, {
      rewrite: (location) => {
        const state = location.searchParams.get("state");
        if (location.pathname.endsWith("/upstream/callback") && state !== null) {
          location.searchParams.set("state", `${state}-tampered`);
        }
        return location;
      },
      stopAt: toApp,
    });

    const logs = await assertRefused(harness, visit);
    assert.equal(logs.at(-1)?.level, "warn");
    assert.equal(logs.at(-1)?.message, "Login refused");
    assert.match(logs.at(-1)?.["error"] ?? "", /state/i);
  });

  it("refuses an ID token whose nonce doesn't match the login", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);

    const visit = await harness.browser.visit(login.authorizationUrl, {
      rewrite: (location) => {
        if (location.origin === harness.upstream.issuer && location.searchParams.has("nonce")) {
          location.searchParams.set("nonce", "not-the-nonce-the-broker-sent");
        }
        return location;
      },
      stopAt: toApp,
    });

    const logs = await assertRefused(harness, visit);
    assert.match(logs.at(-1)?.["error"] ?? "", /OAUTH_JWT_CLAIM_COMPARISON_FAILED/);
  });

  it("refuses an error from the upstream provider", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const toUpstream = await harness.browser.visit(login.authorizationUrl, {
      stopAt: (location) => location.origin === harness.upstream.issuer,
    });
    const state = toUpstream.url.searchParams.get("state") ?? "";

    const callback = new URL(upstreamRedirectUri(harness.issuer));
    callback.search = new URLSearchParams({
      error: "access_denied",
      iss: harness.upstream.issuer,
      state,
    }).toString();
    const visit = await visitUntilPage(harness, callback);

    const logs = await assertRefused(harness, visit);
    assert.match(logs.at(-1)?.["error"] ?? "", /access_denied/);
  });

  it("refuses a callback with no usable state", async () => {
    await using harness = await startHarness();

    const visit = await visitUntilPage(harness, `${upstreamRedirectUri(harness.issuer)}?code=x`);

    await assertRefused(harness, visit);
  });

  for (const [name, query] of [
    ["a state that names no interaction", "state=no-interaction-here"],
    ["two states", "state=abc.first&state=abc.second"],
  ] as const) {
    it(`refuses a callback with ${name}`, async () => {
      await using harness = await startHarness();

      const visit = await visitUntilPage(
        harness,
        `${upstreamRedirectUri(harness.issuer)}?${query}`,
      );

      await assertRefused(harness, visit);
    });
  }

  it("only answers the upstream provider's callback to a GET", async () => {
    await using harness = await startHarness();
    const callback = await captureUpstreamCallback(harness);

    const visit = await visitUntilPage(harness, callback, "POST");

    assert.equal(visit.status, 404);
  });
});

describe("binding each login to its browser", () => {
  const captureCallback = captureUpstreamCallback;

  it("won't finish a login in a browser that didn't start it", async () => {
    await using harness = await startHarness();
    const callback = await captureCallback(harness);

    const visit = await createBrowser().visit(callback, { stopAt: toApp });

    assertPage(visit, expiredPage);
  });

  it("won't use the same callback twice", async () => {
    await using harness = await startHarness();
    const callback = await captureCallback(harness);
    await visitUntilPage(harness, callback);

    const replay = await visitUntilPage(harness, callback);

    assertPage(replay, expiredPage);
  });

  it("won't resume a login that has no pending upstream request", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const toUpstream = await harness.browser.visit(login.authorizationUrl, {
      stopAt: (location) => location.origin === harness.upstream.issuer,
    });
    const uid = toUpstream.url.searchParams.get("state")?.split(".")[0] ?? "";

    // Asking for the interaction again starts a fresh upstream request, and a
    // callback is accepted at most once, so a stale one finds nothing.
    const resume = `${harness.issuer}/interaction/${uid}/upstream?code=stale&state=${uid}.stale`;
    await visitUntilPage(harness, resume);
    const visit = await visitUntilPage(harness, resume);

    assertPage(visit, expiredPage);
  });

  it("won't act on an interaction the browser's cookie doesn't name", async () => {
    await using harness = await startHarness();
    await captureCallback(harness);

    const visit = await visitUntilPage(harness, `${harness.issuer}/interaction/someone-elses-uid`);

    assertPage(visit, expiredPage);
  });

  it("refuses a step that doesn't fit the interaction", async () => {
    await using harness = await startHarness();
    const callback = await captureCallback(harness);
    const uid = callback.searchParams.get("state")?.split(".")[0] ?? "";

    const visit = await visitUntilPage(
      harness,
      `${harness.issuer}/interaction/${uid}/confirm`,
      "POST",
    );

    assertPage(visit, unavailableStepPage);
  });

  it("refuses an upstream return once the login is waiting for consent", async () => {
    await using harness = await startHarness();
    const login = await appLogin(harness);
    const consent = await visitUntilPage(harness, login.authorizationUrl);
    const confirm = new URL(formAction(consent, "Allow"));

    const visit = await visitUntilPage(harness, confirm.href.replace(/\/confirm$/, "/upstream"));

    assertPage(visit, unavailableStepPage);
  });
});

describe("an unavailable upstream provider", () => {
  it("shows that login is unavailable", async () => {
    const closed = await listenOnLoopback();
    const unreachable = closed.origin;
    await closed[Symbol.asyncDispose]();
    await using harness = await startHarness({ upstreamIssuer: unreachable });
    const login = await appLogin(harness);

    const visit = await visitUntilPage(harness, login.authorizationUrl);

    assertPage(visit, {
      heading: "Login is not available",
      message: "The login service could not be reached. Try again later.",
      status: 502,
    });
    assert.equal(harness.logs.at(-1)?.level, "warn");
    assert.equal(harness.logs.at(-1)?.message, "Upstream unavailable");
  });
});

async function captureUpstreamCallback(harness: Harness): Promise<URL> {
  const login = await appLogin(harness);
  const visit = await harness.browser.visit(login.authorizationUrl, {
    stopAt: (location) => location.pathname.endsWith("/upstream/callback"),
  });
  return visit.url;
}
