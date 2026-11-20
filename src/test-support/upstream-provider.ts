import { generateKeyPairSync } from "node:crypto";
import Koa from "koa";
import Provider from "oidc-provider";

import { listenOnLoopback } from "./loopback.ts";

/**
 * A stand-in for the upstream provider, configured the way Pocket ID behaves:
 *
 * - the issuer has no trailing slash
 * - `sub` is an internal ID, not a username or email address
 * - the client authenticates with a secret, and PKCE is required
 * - ID tokens are signed with RS256
 * - it also returns email and username claims, which the broker must ignore
 *
 * It logs in whoever the test chooses, with no login page.
 */
export type UpstreamProvider = AsyncDisposable & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  /** Log in as this subject from now on. */
  logInAs(subject: string): void;
};

export async function startUpstreamProvider(options: {
  /** The broker's callback URL. */
  readonly redirectUri: string;
}): Promise<UpstreamProvider> {
  const server = await listenOnLoopback();
  const clientId = "solid-oidc-broker";
  const clientSecret = "upstream-test-secret-not-used-anywhere-else";
  let subject = "00000000-0000-4000-8000-000000000000";

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = new Provider(server.origin, {
    claims: { email: ["email"], openid: ["sub"], profile: ["preferred_username"] },
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [options.redirectUri],
        token_endpoint_auth_method: "client_secret_post",
      },
    ],
    conformIdTokenClaims: false,
    features: { devInteractions: { enabled: false } },
    findAccount: (_context, sub) => ({
      accountId: sub,
      claims: () => ({
        email: "someone@example.test",
        preferred_username: "someone",
        sub,
      }),
    }),
    jwks: { keys: [{ ...privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig" }] },
    pkce: { required: () => true },
  });

  const app = new Koa();
  app.use(async (context, next) => {
    if (!context.path.startsWith("/interaction/")) {
      await next();
      return;
    }
    const interaction = await provider.interactionDetails(context.req, context.res);
    const result =
      interaction.prompt.name === "login"
        ? { login: { accountId: subject } }
        : { consent: { grantId: await grantAll(provider, interaction) } };
    context.status = 303;
    context.redirect(
      await provider.interactionResult(context.req, context.res, result, {
        mergeWithLastSubmission: true,
      }),
    );
  });
  app.use(async (context) => {
    context.respond = false;
    await provider.callback()(context.req, context.res);
  });
  server.serve(app.callback());

  return {
    clientId,
    clientSecret,
    issuer: server.origin,
    logInAs(next) {
      subject = next;
    },
    [Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
  };
}

type Interaction = Awaited<ReturnType<Provider["interactionDetails"]>>;

async function grantAll(provider: Provider, interaction: Interaction): Promise<string> {
  const grant = new provider.Grant({
    accountId: interaction.session?.accountId ?? "",
    clientId: String(interaction.params["client_id"]),
  });
  grant.addOIDCScope(String(interaction.params["scope"]));
  return grant.save();
}
