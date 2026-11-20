import { once } from "node:events";
import type Koa from "koa";
import Provider, { type ClientMetadata, type Configuration, type FindAccount } from "oidc-provider";

import type { AccountStore } from "./accounts.ts";
import type { ProviderKeys } from "./keys.ts";

export type CreateProviderOptions = {
  readonly accounts: AccountStore;
  /** Clients registered in advance. Solid apps will use Client ID Documents. */
  readonly clients: readonly ClientMetadata[];
  /** The broker's issuer identifier, exactly as configured. */
  readonly issuer: string;
  readonly keys: ProviderKeys;
};

/**
 * Create the Solid-facing OpenID provider. Its accounts are WebIDs, and the
 * broker's interaction routes log people in through the upstream provider.
 */
export function createProvider(options: CreateProviderOptions): Provider {
  const prefix = issuerPath(options.issuer);
  const configuration: Configuration = {
    // The broker's only signing key is ES256, and oidc-provider would
    // otherwise expect an RSA key for any client that doesn't name one.
    clientDefaults: { id_token_signed_response_alg: "ES256" },
    clients: options.clients.map((client) => ({ ...client })),
    cookies: { keys: [...options.keys.cookieKeys] },
    features: {
      // The development views accept any username and password. They must
      // never be reachable, even before the real login exists.
      devInteractions: { enabled: false },
    },
    findAccount: accountFinder(options.accounts),
    interactions: { url: interactionUrlFor(prefix) },
    jwks: { keys: options.keys.signingKeys.map((key) => ({ ...key })) },
  };

  const provider = new Provider(options.issuer, configuration);
  // mountProvider sets the forwarded headers from the issuer, so trusting
  // them makes every URL the provider builds start with the issuer.
  provider.proxy = true;
  return provider;
}

/** The path the provider's routes live under: empty for a bare origin. */
export function issuerPath(issuer: string): string {
  const { pathname } = new URL(issuer);
  return pathname === "/" ? "" : pathname;
}

/** Where the provider sends the browser when it needs the person to log in. */
export function interactionUrl(options: { readonly prefix: string; readonly uid: string }): string {
  return `${options.prefix}/interaction/${options.uid}`;
}

/** The provider's `interactions.url` setting for an issuer path. */
export function interactionUrlFor(
  prefix: string,
): (context: unknown, interaction: { readonly uid: string }) => string {
  return (_context, interaction) => interactionUrl({ prefix, uid: interaction.uid });
}

/**
 * The provider's `findAccount` setting. An account is a WebID, and loads only
 * while the account store still maps some upstream account to it, so removing
 * a mapping ends that person's sessions too.
 */
export function accountFinder(accounts: AccountStore): FindAccount {
  return async (_context, webId) => {
    if (!(await accounts.hasWebId(webId))) {
      return undefined;
    }
    return { accountId: webId, claims: () => ({ sub: webId }) };
  };
}

/**
 * Koa middleware that keeps the rest of the chain to requests under the
 * issuer's path, and answers anything else with 404.
 *
 * The provider builds endpoint URLs and cookie settings from the request's
 * host and protocol. Behind a proxy those differ from the public URL, and a
 * client could set them to anything, so they are replaced with the issuer's
 * before the interaction routes or the provider see the request.
 */
export function scopeToIssuer(issuer: string): Koa.Middleware {
  const issuerUrl = new URL(issuer);
  const prefix = issuerPath(issuer);

  return async (context, next) => {
    if (!isUnder({ path: context.path, prefix })) {
      return;
    }
    const { headers } = context.req;
    headers.host = issuerUrl.host;
    headers["x-forwarded-proto"] = issuerUrl.protocol.slice(0, -1);
    delete headers["x-forwarded-host"];
    await next();
  };
}

/** Koa middleware that hands every request that reaches it to the provider. */
export function mountProvider(options: {
  readonly issuer: string;
  readonly provider: Provider;
}): Koa.Middleware {
  const prefix = issuerPath(options.issuer);
  const handle = options.provider.callback();

  return async (context) => {
    const request = context.req;
    const { originalUrl } = context;
    // oidc-provider works out its mount path from originalUrl.
    Object.assign(request, { originalUrl });
    // What follows the prefix may be empty or start with a query string, and
    // the provider needs a path that starts with a slash either way.
    const rest = originalUrl.slice(prefix.length);
    request.url = rest.startsWith("/") ? rest : `/${rest}`;

    context.respond = false;
    const closed = once(context.res, "close");
    await handle(request, context.res);
    await closed;
  };
}

function isUnder(options: { readonly path: string; readonly prefix: string }): boolean {
  return (
    options.prefix === "" ||
    options.path === options.prefix ||
    options.path.startsWith(`${options.prefix}/`)
  );
}
