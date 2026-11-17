import Koa from "koa";

/** Path of the liveness endpoint used by the container healthcheck. */
export const healthPath = "/health";

/**
 * Build the HTTP application. Routes are added here as the broker grows; the
 * OpenID provider will be mounted alongside the health endpoint.
 */
export function createApp(): Koa {
  const app = new Koa({ proxy: false });

  app.use(async (context, next) => {
    if (context.method === "GET" && context.path === healthPath) {
      context.body = { status: "ok" };
      return;
    }
    await next();
  });

  return app;
}
