import Koa from "koa";

import {
  type InteractionRoutesOptions,
  interactionRoutes,
  upstreamCallbackPath,
} from "./interactions.ts";
import { issuerPath, mountProvider, scopeToIssuer } from "./provider.ts";

/** Path of the liveness endpoint used by the container healthcheck. */
export const healthPath = "/health";

export type CreateAppOptions = Omit<InteractionRoutesOptions, "prefix" | "upstreamRedirectUri"> & {
  /** The broker's issuer identifier, exactly as configured. */
  readonly issuer: string;
};

/**
 * Build the HTTP application: the health endpoint, then, under the issuer's
 * path, the login and consent routes and the OpenID provider.
 */
export function createApp(options: CreateAppOptions): Koa {
  const app = new Koa({ proxy: false });
  const { issuer, ...routes } = options;

  app.use(async (context, next) => {
    if (context.method === "GET" && context.path === healthPath) {
      context.body = { status: "ok" };
      return;
    }
    await next();
  });
  app.use(scopeToIssuer(issuer));
  app.use(
    interactionRoutes({
      ...routes,
      prefix: issuerPath(issuer),
      upstreamRedirectUri: upstreamRedirectUri(issuer),
    }),
  );
  app.use(mountProvider({ issuer, provider: options.provider }));

  return app;
}

/** The callback URL to register with the upstream provider. */
export function upstreamRedirectUri(issuer: string): string {
  return `${issuer}${upstreamCallbackPath}`;
}
