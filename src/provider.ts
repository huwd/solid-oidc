import { once } from "node:events";
import type Koa from "koa";
import Provider, {
  type AdapterFactory,
  type ClientMetadata,
  type Configuration,
  type FindAccount,
} from "oidc-provider";

import type { AccountStore } from "./accounts.ts";
import type { ProviderKeys } from "./keys.ts";
import { pageHeaders, renderErrorPage } from "./pages.ts";
import { type SolidConfigurationOptions, solidConfiguration } from "./solid.ts";

export type CreateProviderOptions = SolidConfigurationOptions & {
  readonly accounts: AccountStore;
  /** Where the provider keeps sessions, grants, codes and tokens. */
  readonly adapter: AdapterFactory;
  /**
   * Clients registered in advance, for tests. Solid apps identify themselves
   * with Client ID Documents instead.
   */
  readonly clients: readonly ClientMetadata[];
  readonly keys: ProviderKeys;
};

/**
 * Create the Solid-facing OpenID provider. Its accounts are WebIDs, and the
 * broker's interaction routes log people in through the upstream provider.
 */
export function createProvider(options: CreateProviderOptions): Provider {
  const prefix = issuerPath(options.issuer);
  const solid = solidConfiguration(options);
  const configuration: Configuration = {
    ...solid,
    adapter: options.adapter,
    clients: options.clients.map((client) => ({ ...client })),
    cookies: { keys: [...options.keys.cookieKeys] },
    features: {
      ...solid.features,
      // The development views accept any username and password. They must
      // never be reachable.
      devInteractions: { enabled: false },
    },
    findAccount: accountFinder(options.accounts),
    interactions: { url: interactionUrlFor(prefix) },
    renderError,
    jwks: { keys: options.keys.signingKeys.map((key) => ({ ...key })) },
  };

  const provider = new Provider(options.issuer, configuration);
  // mountProvider sets the forwarded headers from the issuer, so trusting
  // them makes every URL the provider builds start with the issuer.
  provider.proxy = true;
  return provider;
}

/**
 * Show an error the provider can't send back to the app, such as an unknown
 * client, on the broker's own page. The error code and description come from
 * oidc-provider, not from the request, and the page escapes them anyway.
 */
export function renderError(
  context: Koa.Context,
  out: { readonly error: string; readonly error_description?: string | undefined },
): void {
  const reason =
    out.error_description === undefined ? out.error : `${out.error}: ${out.error_description}`;
  context.set(pageHeaders);
  context.body = renderErrorPage({
    heading: "The app's request was refused",
    message: `Go back to the app and try again. If this keeps happening, tell the app's developer (${reason}).`,
  });
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
    return { accountId: webId, claims: () => ({ sub: webId, webid: webId }) };
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
