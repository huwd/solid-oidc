import type Koa from "koa";
import type Provider from "oidc-provider";
import { errors } from "oidc-provider";
import { z } from "zod";

import type { AccountStore } from "./accounts.ts";
import { pageHeaders, renderConsentPage, renderErrorPage } from "./pages.ts";
import type { PendingLogins } from "./pending-logins.ts";
import { newLoginChecks, type UpstreamClient } from "./upstream.ts";

/** A structured log entry. It must never hold a token, code or secret. */
export type LogEntry = {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly [key: string]: string;
};

export type InteractionRoutesOptions = {
  readonly accounts: AccountStore;
  readonly log: (entry: LogEntry) => void;
  readonly pendingLogins: PendingLogins;
  /** The issuer's path: empty for a bare origin. */
  readonly prefix: string;
  readonly provider: Provider;
  readonly upstream: UpstreamClient;
  /** The callback URL registered with the upstream provider. */
  readonly upstreamRedirectUri: string;
};

/** The path, under the issuer, the upstream provider sends the browser back to. */
export const upstreamCallbackPath = "/upstream/callback";

// oidc-provider's interaction IDs are URL-safe random strings. Accepting no
// other characters keeps the ID safe to put back into a path.
const uidPattern = "[A-Za-z0-9_-]{1,64}";
const interactionRoute = new RegExp(`^/interaction/(${uidPattern})(?:/(upstream|confirm|abort))?$`);
const stateUid = new RegExp(`^(${uidPattern})\\.`);

// What the provider says the grant lacks: OpenID scopes and claims, and
// scopes for the Solid resource, the only resource the broker issues for.
const ConsentDetails = z.object({
  missingOIDCClaims: z.array(z.string()).optional(),
  missingOIDCScope: z.array(z.string()).optional(),
  missingResourceScopes: z.record(z.string(), z.array(z.string())).optional(),
});

/**
 * Koa middleware for the login and consent steps the provider hands over to
 * the broker:
 *
 * 1. The provider sends the browser to `/interaction/:uid`. For a login, the
 *    broker sends it on to the upstream provider, with PKCE, `state` and
 *    `nonce` bound to this interaction.
 * 2. The upstream provider returns to `/upstream/callback`. That path can't
 *    see the interaction's cookie, so it sends the browser on to
 *    `/interaction/:uid/upstream`, taking the ID from `state`.
 * 3. There, with the cookie, the broker checks the upstream ID token and maps
 *    exactly its issuer and subject to a WebID.
 * 4. For consent, `/interaction/:uid` shows which app wants which WebID, and
 *    the form posts to `confirm` or `abort`.
 *
 * Binding each step to the interaction's cookie means a callback started in
 * one browser can't finish a login in another.
 */
export function interactionRoutes(options: InteractionRoutesOptions): Koa.Middleware {
  return async (context, next) => {
    const path = context.path.slice(options.prefix.length);
    if (path === upstreamCallbackPath && context.method === "GET") {
      returnFromUpstream({ context, prefix: options.prefix });
      return;
    }

    const match = interactionRoute.exec(path);
    const uid = match?.[1];
    if (uid === undefined) {
      await next();
      return;
    }

    const step = `${context.method} ${match?.[2] ?? ""}`;
    try {
      await handleStep({ context, options, step, uid });
    } catch (error) {
      if (!(error instanceof errors.SessionNotFound)) {
        throw error;
      }
      sendError(context, {
        heading: "This login has expired",
        message: "Go back to the app and start again.",
        status: 400,
      });
    }
  };
}

async function handleStep(input: {
  readonly context: Koa.Context;
  readonly options: InteractionRoutesOptions;
  readonly step: string;
  readonly uid: string;
}): Promise<void> {
  const { context, options, step, uid } = input;
  const interaction = await options.provider.interactionDetails(context.req, context.res);
  if (interaction.uid !== uid) {
    throw new errors.SessionNotFound("interaction does not match its cookie");
  }

  const prompt = interaction.prompt.name;
  if (step === "GET " && prompt === "login") {
    await startUpstreamLogin({ context, options, uid });
  } else if (step === "GET upstream" && prompt === "login") {
    await finishUpstreamLogin({ context, options, uid });
  } else if (step === "GET " && prompt === "consent") {
    await showConsent({ context, interaction, options, uid });
  } else if (step === "POST confirm" && prompt === "consent") {
    await confirmConsent({ context, interaction, options });
  } else if (step === "POST abort") {
    const result = { error: "access_denied", error_description: "The person declined." };
    await finish({ context, options, result });
  } else {
    sendError(context, {
      heading: "This page is not available",
      message: "Go back to the app and start again.",
      status: 400,
    });
  }
}

type Interaction = Awaited<ReturnType<Provider["interactionDetails"]>>;

type StepInput = {
  readonly context: Koa.Context;
  readonly options: InteractionRoutesOptions;
  readonly uid: string;
};

async function startUpstreamLogin({ context, options, uid }: StepInput): Promise<void> {
  const fresh = newLoginChecks();
  const checks = { ...fresh, state: `${uid}.${fresh.state}` };
  const url = await options.upstream.authorizationUrl(checks);
  if (!url.ok) {
    options.log({ error: url.errors.join("; "), level: "warn", message: "Upstream unavailable" });
    sendError(context, {
      heading: "Login is not available",
      message: "The login service could not be reached. Try again later.",
      status: 502,
    });
    return;
  }
  options.pendingLogins.put(uid, checks);
  context.status = 303;
  context.redirect(url.value.href);
}

async function finishUpstreamLogin({ context, options, uid }: StepInput): Promise<void> {
  const checks = options.pendingLogins.take(uid);
  if (checks === undefined) {
    throw new errors.SessionNotFound("no pending upstream login");
  }

  const callbackUrl = new URL(options.upstreamRedirectUri);
  callbackUrl.search = context.querystring;
  const identity = await options.upstream.identify({ callbackUrl, checks });
  if (!identity.ok) {
    options.log({ error: identity.errors.join("; "), level: "warn", message: "Login refused" });
    sendNoLogin(context);
    return;
  }

  // The only place an upstream account becomes a WebID: exactly its issuer
  // and subject, never any other claim. See decision 0004.
  const webId = await options.accounts.findWebId(identity.value);
  if (webId === undefined) {
    // The subject is the upstream provider's internal ID, which an
    // administrator needs to add the mapping. It is not a secret.
    options.log({
      level: "info",
      message: "No account for upstream identity",
      upstreamIssuer: identity.value.issuer,
      upstreamSubject: identity.value.subject,
    });
    sendNoLogin(context);
    return;
  }

  await finish({ context, options, result: { login: { accountId: webId } } });
}

async function showConsent(
  input: StepInput & { readonly interaction: Interaction },
): Promise<void> {
  const { context, interaction, options, uid } = input;
  const clientId = String(interaction.params["client_id"]);
  const client = await options.provider.Client.find(clientId);
  const base = `${options.prefix}/interaction/${uid}`;
  context.set(pageHeaders);
  context.body = renderConsentPage({
    abortPath: `${base}/abort`,
    clientId,
    clientName: client?.clientName,
    confirmPath: `${base}/confirm`,
    webId: accountOf(interaction),
  });
}

async function confirmConsent(input: {
  readonly context: Koa.Context;
  readonly interaction: Interaction;
  readonly options: InteractionRoutesOptions;
}): Promise<void> {
  const { context, interaction, options } = input;
  const accountId = accountOf(interaction);
  const details = ConsentDetails.parse(interaction.prompt.details);
  const { Grant } = options.provider;
  const existing =
    interaction.grantId === undefined ? undefined : await Grant.find(interaction.grantId);
  const grant =
    existing ?? new Grant({ accountId, clientId: String(interaction.params["client_id"]) });

  if (details.missingOIDCScope !== undefined) {
    grant.addOIDCScope(details.missingOIDCScope);
  }
  /* node:coverage ignore next 5 */
  // Unreachable: the claims request parameter is turned off, so a client can
  // ask for claims, such as webid, only through scopes.
  if (details.missingOIDCClaims !== undefined) {
    grant.addOIDCClaims(details.missingOIDCClaims);
  }

  for (const [resource, scopes] of Object.entries(details.missingResourceScopes ?? {})) {
    grant.addResourceScope(resource, scopes);
  }

  const grantId = await grant.save();
  await finish({ context, options, result: { consent: { grantId } } });
}

async function finish(input: {
  readonly context: Koa.Context;
  readonly options: InteractionRoutesOptions;
  readonly result: Parameters<Provider["interactionResult"]>[2];
}): Promise<void> {
  const { context, options, result } = input;
  const returnTo = await options.provider.interactionResult(context.req, context.res, result, {
    mergeWithLastSubmission: true,
  });
  context.status = 303;
  context.redirect(returnTo);
}

function accountOf(interaction: Interaction): string {
  const accountId = interaction.session?.accountId;
  /* node:coverage ignore next 4 */
  // Unreachable: the provider asks for consent only after a login.
  if (accountId === undefined) {
    throw new errors.SessionNotFound("consent without a login");
  }
  return accountId;
}

function returnFromUpstream(input: {
  readonly context: Koa.Context;
  readonly prefix: string;
}): void {
  const { context, prefix } = input;
  const state = context.query["state"];
  const uid = typeof state === "string" ? stateUid.exec(state)?.[1] : undefined;
  if (uid === undefined) {
    sendNoLogin(context);
    return;
  }
  // The query, with the code and state, goes along unchanged; the next step
  // checks it against the login this interaction started.
  context.status = 303;
  context.redirect(`${prefix}/interaction/${uid}/upstream?${context.querystring}`);
}

// One page for every refused login, so it can't tell anyone which upstream
// accounts have a WebID.
function sendNoLogin(context: Koa.Context): void {
  sendError(context, {
    heading: "You could not be logged in",
    message:
      "Go back to the app and try again. If this keeps happening, contact the administrator.",
    status: 403,
  });
}

function sendError(
  context: Koa.Context,
  page: { readonly heading: string; readonly message: string; readonly status: number },
): void {
  context.status = page.status;
  context.set(pageHeaders);
  context.body = renderErrorPage(page);
}
