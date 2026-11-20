import { randomBytes } from "node:crypto";
import Koa from "koa";
import * as client from "openid-client";

import { escapeHtml, readForm, sendPage } from "./html.ts";
import { type Settings, urls } from "./settings.ts";

/**
 * A stub Solid app. It logs in with the broker as a real Solid app does,
 * with a Client ID Document, PKCE and DPoP, then shows what came back.
 * It also serves Alice's WebID profile.
 */
export type StubApp = {
  /** The app's pages, on plain HTTP. */
  readonly app: Koa;
  /** The Client ID Document, which the broker fetches over HTTPS. */
  readonly clientDocument: Koa;
};

type PendingLogin = {
  readonly codeVerifier: string;
  readonly keyPair: client.CryptoKeyPair;
  readonly nonce: string;
};

type Session = {
  readonly keyPair: client.CryptoKeyPair;
  readonly tokens: client.TokenEndpointResponse;
};

// The sandbox is for one person at a time, so a small bound is plenty.
const entriesMax = 100;

export function createStubApp(settings: Settings): StubApp {
  const redirectUri = `${urls.app}/callback`;
  const pending = boundedMap<PendingLogin>();
  const sessions = boundedMap<Session>();
  let configuration: Promise<client.Configuration> | undefined;

  // Discover the broker on first use, and again after a failure, so the app
  // works whichever service starts first.
  function broker(): Promise<client.Configuration> {
    configuration ??= client
      .discovery(new URL(urls.broker), urls.clientDocument, undefined, client.None(), {
        execute: [client.allowInsecureRequests],
      })
      .catch((error: unknown) => {
        configuration = undefined;
        throw error;
      });
    return configuration;
  }

  const clientDocument = new Koa();
  clientDocument.use((context) => {
    if (context.path !== new URL(urls.clientDocument).pathname) {
      context.status = 404;
      return;
    }
    context.type = "application/ld+json";
    context.body = {
      "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
      client_id: urls.clientDocument,
      client_name: settings.appName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      scope: settings.appScope,
      token_endpoint_auth_method: "none",
    };
  });

  const app = new Koa();
  app.use(async (context, next) => {
    try {
      await next();
    } catch (error) {
      sendPage(context, {
        body: `<h1>Something went wrong</h1><pre>${escapeHtml(describe(error))}</pre><p><a href="/">Start again</a></p>`,
        title: "Error",
      });
      context.status = 500;
    }
  });
  app.use(async (context) => {
    const route = `${context.method} ${context.path}`;
    switch (route) {
      case "GET /health":
        context.body = { status: "ok" };
        return;
      case "GET /profile/card":
        context.type = "text/turtle";
        context.body = profile();
        return;
      case "GET /":
        showHome(context, settings);
        return;
      case "POST /login":
        await startLogin(context);
        return;
      case "GET /callback":
        await finishLogin(context);
        return;
      case "POST /refresh":
        await refresh(context);
        return;
      default:
        context.status = 404;
    }
  });

  async function startLogin(context: Koa.Context): Promise<void> {
    const configured = await broker();
    const codeVerifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    const state = client.randomState();
    pending.set(state, { codeVerifier, keyPair: await client.randomDPoPKeyPair("ES256"), nonce });
    const parameters: Record<string, string> = {
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      nonce,
      redirect_uri: redirectUri,
      scope: settings.appScope,
      state,
    };
    // oidc-provider issues a refresh token only when consent is asked for.
    if (settings.appScope.split(" ").includes("offline_access")) {
      parameters["prompt"] = "consent";
    }
    context.status = 303;
    context.redirect(client.buildAuthorizationUrl(configured, parameters).href);
  }

  async function finishLogin(context: Koa.Context): Promise<void> {
    const error = context.query["error"];
    if (typeof error === "string") {
      sendPage(context, {
        body: `<h1>The broker returned an error</h1>
<pre>${escapeHtml(JSON.stringify(context.query, null, 2))}</pre>
<p><a href="/">Start again</a></p>`,
        title: "Login error",
      });
      return;
    }
    const state = String(context.query["state"]);
    const login = pending.take(state);
    if (login === undefined) {
      context.throw(400, "No login is waiting for this state. Start again.");
    }
    const configured = await broker();
    const tokens = await client.authorizationCodeGrant(
      configured,
      new URL(context.originalUrl, urls.app),
      { expectedNonce: login.nonce, expectedState: state, pkceCodeVerifier: login.codeVerifier },
      undefined,
      { DPoP: client.getDPoPHandle(configured, login.keyPair) },
    );
    const sessionId = randomBytes(16).toString("base64url");
    sessions.set(sessionId, { keyPair: login.keyPair, tokens });
    showTokens(context, { heading: "Logged in", sessionId, tokens });
  }

  async function refresh(context: Koa.Context): Promise<void> {
    const sessionId = (await readForm(context)).get("session") ?? "";
    const session = sessions.take(sessionId);
    const refreshToken = session?.tokens.refresh_token;
    if (session === undefined || refreshToken === undefined) {
      context.throw(400, "That session has no refresh token. Start again.");
    }
    const configured = await broker();
    const tokens = await client.refreshTokenGrant(configured, refreshToken, undefined, {
      DPoP: client.getDPoPHandle(configured, session.keyPair),
    });
    sessions.set(sessionId, { keyPair: session.keyPair, tokens });
    showTokens(context, { heading: "Refreshed", sessionId, tokens });
  }

  return { app, clientDocument };
}

function showHome(context: Koa.Context, settings: Settings): void {
  sendPage(context, {
    body: `<h1>${escapeHtml(settings.appName)}</h1>
<p class="note">A stub Solid app. Its Client ID Document is <a href="${urls.clientDocument}"><code>${urls.clientDocument}</code></a>, and it asks for <code>${escapeHtml(settings.appScope)}</code>.</p>
<form method="post" action="/login"><button>Log in with the broker</button></form>
<p class="note">The broker is <a href="${urls.broker}/.well-known/openid-configuration">${urls.broker}</a>. Alice's WebID is <a href="${urls.app}/profile/card"><code>${urls.app}/profile/card#me</code></a>.</p>`,
    title: settings.appName,
  });
}

function showTokens(
  context: Koa.Context,
  options: {
    readonly heading: string;
    readonly sessionId: string;
    readonly tokens: client.TokenEndpointResponse;
  },
): void {
  const { tokens } = options;
  const idToken = tokens.id_token === undefined ? "(none)" : decodeJwt(tokens.id_token);
  const refreshForm =
    tokens.refresh_token === undefined
      ? `<p class="note">No refresh token: the app didn't ask for <code>offline_access</code>.</p>`
      : `<form method="post" action="/refresh"><input type="hidden" name="session" value="${escapeHtml(options.sessionId)}"><button>Refresh the tokens</button></form>`;
  sendPage(context, {
    body: `<h1>${escapeHtml(options.heading)}</h1>
<p>Token type <code>${escapeHtml(tokens.token_type)}</code>, expires in ${escapeHtml(String(tokens.expires_in ?? "?"))} seconds.</p>
<h2>Access token</h2>
<p class="note">A Solid server checks <code>webid</code>, <code>client_id</code>, <code>aud</code> and that <code>cnf.jkt</code> matches the app's DPoP key.</p>
<pre>${escapeHtml(decodeJwt(tokens.access_token))}</pre>
<h2>ID token</h2>
<pre>${escapeHtml(idToken)}</pre>
${refreshForm}
<p><a href="/">Start again</a></p>`,
    title: options.heading,
  });
}

function profile(): string {
  return `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<#me>
  a foaf:Person;
  foaf:name "Alice";
  solid:oidcIssuer <${urls.broker}>.
`;
}

function decodeJwt(jwt: string): string {
  const [header = "", payload = ""] = jwt.split(".");
  const decode = (part: string): unknown =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return JSON.stringify({ header: decode(header), payload: decode(payload) }, null, 2);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? `\nCaused by: ${error.cause.message}` : "";
  return `${error.name}: ${error.message}${cause}`;
}

function boundedMap<T>() {
  const entries = new Map<string, T>();
  return {
    set(key: string, value: T): void {
      entries.delete(key);
      if (entries.size >= entriesMax) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
      entries.set(key, value);
    },
    take(key: string): T | undefined {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
  };
}
