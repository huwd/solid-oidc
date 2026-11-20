import { type Configuration, errors, type KoaContextWithOIDC } from "oidc-provider";

import { tokenLifetimeSeconds } from "./lifetimes.ts";

/**
 * The parts of the provider's configuration that make it a Solid-OIDC
 * issuer, rather than an ordinary OpenID provider. See
 * https://solidproject.org/TR/oidc.
 */

/** The value discovery advertises as `solid_oidc_supported`. */
export const solidOidcSupported = "https://solidproject.org/TR/solid-oidc";

/**
 * The one resource the broker issues access tokens for. Solid servers don't
 * register with the broker, so every access token is for "Solid" in general,
 * with the audience Solid-OIDC requires.
 */
export const solidResource = "urn:solid";

const solidAudience = "solid";

// A Client ID Document is a few hundred bytes. The limit stops a hostile
// client wasting memory, and the cache bounds keep a changed document from
// being ignored for long while sparing the client's server.
const clientDocumentBytesMax = 5_120;
const clientDocumentCacheSeconds = { max: 3_600, min: 60 } as const;

export type SolidConfigurationOptions = {
  /**
   * Fetch Client ID Documents from loopback addresses. Never set this in
   * production: it lets an app's `client_id` reach services on the broker's
   * own host. See decision 0009.
   */
  readonly allowLoopbackClientIds: boolean;
  /**
   * Fetches Client ID Documents. oidc-provider adds a timeout and, in
   * production, a connection policy that refuses private and loopback
   * addresses, so pass `globalThis.fetch` there. Tests pass a fake.
   */
  readonly fetch: typeof globalThis.fetch;
  /** The broker's issuer identifier, exactly as configured. */
  readonly issuer: string;
  /** The upstream provider's issuer. No client may claim to be it. */
  readonly upstreamIssuer: string;
};

/** The Solid-OIDC settings to merge into the provider's configuration. */
export function solidConfiguration(options: SolidConfigurationOptions) {
  // By host, not origin: a client_id is always HTTPS, and the issuers may
  // not be, as in tests on loopback.
  const trustedHosts = new Set([
    new URL(options.issuer).host,
    new URL(options.upstreamIssuer).host,
  ]);

  return {
    claims: { openid: ["sub"], webid: ["webid"] },
    clientDefaults: {
      // Solid servers accept only DPoP-bound access tokens, so a client
      // can't get any other kind.
      dpop_bound_access_tokens: true,
      // The broker's only signing key is ES256, and oidc-provider would
      // otherwise expect an RSA key for any client that doesn't name one.
      id_token_signed_response_alg: "ES256",
    },
    discovery: { solid_oidc_supported: solidOidcSupported },
    extraTokenClaims: (
      _context: KoaContextWithOIDC,
      token: { readonly kind: string; readonly accountId?: string },
    ) =>
      token.kind === "AccessToken" && token.accountId !== undefined
        ? { webid: token.accountId }
        : undefined,
    features: {
      clientIdMetadataDocument: {
        ack: "draft-03",
        // A client claiming to be the broker or the upstream provider could
        // confuse anyone reading the consent page or a token.
        allowFetch: (_context: KoaContextWithOIDC, clientId: string) =>
          Promise.resolve(!trustedHosts.has(new URL(clientId).host)),
        cacheDuration: clientDocumentCacheSeconds,
        enabled: true,
      },
      dPoP: { enabled: true },
      resourceIndicators: {
        defaultResource: () => solidResource,
        enabled: true,
        getResourceServerInfo: (_context: KoaContextWithOIDC, resource: string) => {
          if (resource !== solidResource) {
            throw new errors.InvalidTarget("the broker issues tokens only for Solid");
          }
          return {
            accessTokenFormat: "jwt",
            accessTokenTTL: tokenLifetimeSeconds,
            audience: solidAudience,
            jwt: { sign: { alg: "ES256" } },
            scope: "webid",
          } as const;
        },
        useGrantedResource: () => true,
      },
    },
    fetch: clientDocumentFetch({
      allowLoopback: options.allowLoopbackClientIds,
      fetch: options.fetch,
    }),
    fetchResponseBodyLimits: { "client_id metadata document": clientDocumentBytesMax },
    scopes: ["openid", "offline_access", "webid"],
  } satisfies Configuration;
}

/**
 * The fetch oidc-provider calls for Client ID Documents.
 *
 * It asks for JSON-LD as well as JSON. Solid apps often publish their Client
 * ID Document as JSON-LD, which is JSON with an `@context`, and a server that
 * negotiates content may refuse a request for plain JSON alone.
 *
 * oidc-provider passes an undici `dispatcher` that refuses private and
 * loopback addresses. With `allowLoopback`, and only for a URL whose host is
 * a loopback name or address, the dispatcher is dropped. Every other URL
 * keeps the protection.
 */
export function clientDocumentFetch(options: {
  readonly allowLoopback: boolean;
  readonly fetch: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/ld+json, application/json;q=0.9");
    const { dispatcher, ...rest } = (init ?? {}) as RequestInit & { readonly dispatcher?: unknown };
    const keepsProtection = !(options.allowLoopback && isLoopbackUrl(input));
    return options.fetch(input, { ...rest, ...(keepsProtection ? { dispatcher } : {}), headers });
  };
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackUrl(input: string | URL | Request): boolean {
  const url = input instanceof Request ? input.url : input;
  return loopbackHosts.has(new URL(url).hostname);
}
