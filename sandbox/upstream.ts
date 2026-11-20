import { generateKeyPairSync, randomBytes } from "node:crypto";
import Koa from "koa";
import Provider from "oidc-provider";

import { escapeHtml, readForm, sendPage } from "./html.ts";
import { type Settings, upstreamClientId, urls } from "./settings.ts";

/**
 * A stub upstream provider that behaves like Pocket ID, but asks which
 * subject to log in as instead of asking for a passkey:
 *
 * - the issuer has no trailing slash, and `sub` is an internal ID
 * - the broker authenticates with a client secret, and PKCE is required
 * - ID tokens are RS256, and include email and username claims, which the
 *   broker must ignore
 */
export function createUpstream(settings: Settings): Koa {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = new Provider(urls.upstream, {
    claims: { email: ["email"], openid: ["sub"], profile: ["preferred_username"] },
    clients: [
      {
        client_id: upstreamClientId,
        client_secret: settings.upstreamClientSecret,
        redirect_uris: [`${urls.broker}/upstream/callback`],
        token_endpoint_auth_method: "client_secret_post",
      },
    ],
    conformIdTokenClaims: false,
    cookies: { keys: [randomBytes(32).toString("base64url")] },
    features: { devInteractions: { enabled: false } },
    findAccount: (_context, sub) => ({
      accountId: sub,
      claims: () => ({
        email: `${sub.slice(0, 8)}@example.test`,
        preferred_username: sub.slice(0, 8),
        sub,
      }),
    }),
    jwks: { keys: [{ ...privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig" }] },
    pkce: { required: () => true },
  });

  const app = new Koa();
  app.use(async (context, next) => {
    const match = /^\/interaction\/([\w-]+)(\/login)?$/.exec(context.path);
    if (match === null) {
      await next();
      return;
    }
    const interaction = await provider.interactionDetails(context.req, context.res);

    if (interaction.prompt.name === "consent") {
      // The broker is the only client, so consent is given without asking.
      const grant = new provider.Grant({
        accountId: interaction.session?.accountId ?? "",
        clientId: upstreamClientId,
      });
      grant.addOIDCScope(String(interaction.params["scope"]));
      const result = { consent: { grantId: await grant.save() } };
      context.status = 303;
      context.redirect(await provider.interactionResult(context.req, context.res, result));
      return;
    }

    if (context.method === "POST" && match[2] === "/login") {
      const subject = (await readForm(context)).get("subject")?.trim() ?? "";
      if (subject === "") {
        context.throw(400, "Choose a subject");
      }
      const result = { login: { accountId: subject } };
      context.status = 303;
      context.redirect(await provider.interactionResult(context.req, context.res, result));
      return;
    }

    const action = `/interaction/${escapeHtml(interaction.uid)}/login`;
    const buttons = settings.subjects
      .map(
        (subject) =>
          `<form method="post" action="${action}"><button name="subject" value="${escapeHtml(subject.subject)}">${escapeHtml(subject.label)}</button> <code>${escapeHtml(subject.subject)}</code></form>`,
      )
      .join("\n");
    sendPage(context, {
      body: `<h1>Stub upstream provider</h1>
<p class="note">This stands in for Pocket ID. Choose who to log in as. The broker sees only the subject.</p>
${buttons}
<form method="post" action="${action}">
<label>Or another subject: <input name="subject" required></label> <button>Log in</button>
</form>`,
      title: "Stub upstream provider",
    });
  });
  app.use(async (context) => {
    context.respond = false;
    await provider.callback()(context.req, context.res);
  });
  return app;
}
