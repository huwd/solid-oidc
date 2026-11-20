import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";

/** A server on a free loopback port, whose origin is known before it serves. */
export type LoopbackServer = AsyncDisposable & {
  /** Such as `http://127.0.0.1:54321`, with no trailing slash. */
  readonly origin: string;
  /** Start answering requests. Call it once the handler can be built. */
  serve(handler: RequestListener): void;
};

/**
 * Listen first and build the handler afterwards. An OpenID provider needs
 * its issuer URL, port included, before it can be created.
 */
export async function listenOnLoopback(): Promise<LoopbackServer> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the server to listen on a TCP port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    serve(handler) {
      server.on("request", handler);
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
