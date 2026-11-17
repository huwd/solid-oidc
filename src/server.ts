import { once } from "node:events";
import type { Server } from "node:http";
import type Koa from "koa";

/** A listening HTTP server. Dispose of it to stop listening. */
export type RunningServer = AsyncDisposable & {
  /** The port actually bound, which differs from the requested one for port 0. */
  readonly port: number;
};

export type StartServerOptions = {
  readonly app: Koa;
  readonly host: string;
  readonly port: number;
};

/** Start listening, and resolve once the port is bound. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server: Server = options.app.listen({ host: options.host, port: options.port });
  await once(server, "listening");

  const address = server.address();
  /* node:coverage ignore next 4 */
  // Unreachable: a TCP server that has emitted "listening" has an object address.
  if (address === null || typeof address === "string") {
    throw new Error(`Expected a TCP address, got ${String(address)}`);
  }

  return {
    port: address.port,
    [Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
  };
}
