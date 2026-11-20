import { once } from "node:events";
import type Koa from "koa";
import Provider, { type Configuration } from "oidc-provider";

import type { ProviderKeys } from "./keys.ts";

export type CreateProviderOptions = {
  /** The broker's issuer identifier, exactly as configured. */
  readonly issuer: string;
  readonly keys: ProviderKeys;
};

/**
 * Create the Solid-facing OpenID provider. Logging in is not available yet:
 * no account can be found, and the interaction route is a placeholder.
 */
export function createProvider(options: CreateProviderOptions): Provider {
  const prefix = issuerPath(options.issuer);
  const configuration: Configuration = {
    clients: [],
    cookies: { keys: [...options.keys.cookieKeys] },
    features: {
      // The development views accept any username and password. They must
      // never be reachable, even before the real login exists.
      devInteractions: { enabled: false },
    },
    findAccount: findNoAccount,
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

/** No account can log in until the upstream login exists. */
export function findNoAccount(): undefined {
  return undefined;
}

/**
 * Koa middleware that hands requests under the issuer's path to the provider.
 *
 * Endpoint URLs in discovery and tokens are built from the request's host and
 * protocol. Behind a proxy those differ from the public URL, and a client
 * could set them to anything, so they are replaced with the issuer's before
 * the provider sees the request.
 */
export function mountProvider(options: {
  readonly issuer: string;
  readonly provider: Provider;
}): Koa.Middleware {
  const issuerUrl = new URL(options.issuer);
  const prefix = issuerPath(options.issuer);
  const handle = options.provider.callback();

  return async (context, next) => {
    if (!isUnder({ path: context.path, prefix })) {
      await next();
      return;
    }

    const request = context.req;
    const { originalUrl } = context;
    // oidc-provider works out its mount path from originalUrl.
    Object.assign(request, { originalUrl });
    // What follows the prefix may be empty or start with a query string, and
    // the provider needs a path that starts with a slash either way.
    const rest = originalUrl.slice(prefix.length);
    request.url = rest.startsWith("/") ? rest : `/${rest}`;
    request.headers.host = issuerUrl.host;
    request.headers["x-forwarded-proto"] = issuerUrl.protocol.slice(0, -1);
    delete request.headers["x-forwarded-host"];

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
