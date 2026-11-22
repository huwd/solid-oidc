import * as client from "openid-client";

import type { UpstreamIdentity } from "./accounts.ts";
import type { Result } from "./validation.ts";

/** The broker's side of an OpenID Connect login with the upstream provider. */
export type UpstreamClient = {
  /** Where to send the browser to log in upstream. */
  authorizationUrl(checks: LoginChecks): Promise<Result<URL>>;
  /**
   * Exchange the code in the callback for an ID token, check it, and return
   * only the issuer and subject. Nothing else from the token leaves here, so
   * no other claim can be used to choose an account.
   */
  identify(options: {
    /**
     * The redirect URI with the callback's query. openid-client sends this
     * URL, less its query, as the token request's `redirect_uri`.
     */
    readonly callbackUrl: URL;
    readonly checks: LoginChecks;
  }): Promise<Result<UpstreamIdentity>>;
};

/** Values bound to one login, checked when the upstream provider answers. */
export type LoginChecks = {
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly state: string;
};

export type CreateUpstreamClientOptions = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  /** The broker's callback URL, registered with the upstream provider. */
  readonly redirectUri: string;
};

/** Generate fresh, single-use values for a login. */
export function newLoginChecks(): LoginChecks {
  return {
    codeVerifier: client.randomPKCECodeVerifier(),
    nonce: client.randomNonce(),
    state: client.randomState(),
  };
}

/**
 * Create the upstream client. Discovery happens on the first login, not at
 * start, so the broker still starts while the upstream provider is down. A
 * failed discovery is retried on the next login.
 */
export function createUpstreamClient(options: CreateUpstreamClientOptions): UpstreamClient {
  let configuration: Promise<client.Configuration> | undefined;

  function discover(): Promise<client.Configuration> {
    configuration ??= client
      .discovery(
        new URL(options.issuer),
        options.clientId,
        options.clientSecret,
        undefined,
        // The configuration accepts plain HTTP only for a loopback address,
        // which is how the tests run their own upstream provider.
        // Stryker disable next-line ArrayDeclaration: openid-client applies these only after
        // discovery succeeds, and no test has a reachable HTTPS upstream.
        { execute: isHttp(options.issuer) ? [client.allowInsecureRequests] : [] },
      )
      .catch((error: unknown) => {
        configuration = undefined;
        throw error;
      });
    return configuration;
  }

  return {
    async authorizationUrl(checks) {
      let configured: client.Configuration;
      try {
        configured = await discover();
      } catch (error) {
        return { ok: false, errors: [`upstream discovery failed (${failureCode(error)})`] };
      }
      const parameters = {
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: "S256",
        nonce: checks.nonce,
        redirect_uri: options.redirectUri,
        scope: "openid",
        state: checks.state,
      };
      return { ok: true, value: client.buildAuthorizationUrl(configured, parameters) };
    },

    async identify({ callbackUrl, checks }) {
      let claims: client.IDToken | undefined;
      try {
        const tokens = await client.authorizationCodeGrant(await discover(), callbackUrl, {
          expectedNonce: checks.nonce,
          expectedState: checks.state,
          // Stryker disable next-line BooleanLiteral: the check below refuses a login without an
          // ID token too.
          idTokenExpected: true,
          pkceCodeVerifier: checks.codeVerifier,
        });
        claims = tokens.claims();
      } catch (error) {
        return { ok: false, errors: [`upstream login failed (${failureCode(error)})`] };
      }
      /* node:coverage ignore next 6 */
      // Unreachable: idTokenExpected makes the grant fail without an ID token.
      // Stryker disable all: unreachable, as above.
      if (claims === undefined) {
        return { ok: false, errors: ["upstream login failed (no ID token)"] };
      }
      // Stryker restore all
      return { ok: true, value: { issuer: claims.iss, subject: claims.sub } };
    },
  };
}

// openid-client's errors carry a code, such as OAUTH_JWT_CLAIM_COMPARISON_FAILED
// for a wrong nonce, a message naming the parameter or claim that failed, and
// the upstream's OAuth error, such as access_denied. None of them repeats a
// token, a code or a secret, so all are safe to log.
function failureCode(error: unknown): string {
  /* node:coverage ignore next 6 */
  // Unreachable: openid-client throws only Error instances.
  // Stryker disable all: unreachable, as above.
  if (!(error instanceof Error)) {
    return "unknown error";
  }
  // Stryker restore all
  const oauthError = stringProperty(error, "error");
  const code = stringProperty(error, "code") ?? error.name;
  // The wrapped error's message is the specific one, such as which parameter
  // failed. Its own cause holds the response's values, so it is left out.
  const reason = error.cause instanceof Error ? error.cause.message : error.message;
  const detail = oauthError === undefined ? reason : `${oauthError}, ${reason}`;
  return `${code}: ${detail}`;
}

function stringProperty(error: Error, name: "code" | "error"): string | undefined {
  const value: unknown = Reflect.get(error, name);
  // Stryker disable next-line ConditionalExpression: openid-client sets these properties only
  // to strings, so tests can't tell keeping any value from keeping only strings.
  return typeof value === "string" ? value : undefined;
}

function isHttp(url: string): boolean {
  // Stryker disable next-line ConditionalExpression: allowing plain HTTP changes nothing for an
  // HTTPS issuer, so tests can't tell. The HTTP tests check it's allowed where needed.
  return new URL(url).protocol === "http:";
}
