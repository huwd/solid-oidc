import Koa from "koa";
import type Provider from "oidc-provider";

import { interactionUrl, issuerPath, mountProvider } from "./provider.ts";

/** Path of the liveness endpoint used by the container healthcheck. */
export const healthPath = "/health";

export type CreateAppOptions = {
  /** The broker's issuer identifier, exactly as configured. */
  readonly issuer: string;
  readonly provider: Provider;
};

/**
 * Build the HTTP application: the health endpoint, the login interaction
 * route, and the OpenID provider under the issuer's path.
 */
export function createApp(options: CreateAppOptions): Koa {
  const app = new Koa({ proxy: false });
  const interactionPrefix = interactionUrl({ prefix: issuerPath(options.issuer), uid: "" });

  app.use(async (context, next) => {
    if (context.method === "GET" && context.path === healthPath) {
      context.body = { status: "ok" };
      return;
    }
    await next();
  });

  // Placeholder until the upstream login exists: say so plainly rather than
  // letting the provider answer with a generic not-found page.
  app.use(async (context, next) => {
    if (!context.path.startsWith(interactionPrefix)) {
      await next();
      return;
    }
    context.status = 503;
    context.body = { error: "login_unavailable", message: "Login is not available yet." };
  });

  app.use(mountProvider({ issuer: options.issuer, provider: options.provider }));

  return app;
}
