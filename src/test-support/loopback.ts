import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";

/** A server on a free loopback port, whose origin is known before it serves. */
export type LoopbackServer = AsyncDisposable & {
  /** Such as `http://127.0.0.1:54321`, with no trailing slash. */
  readonly origin: string;
  /**
   * Answer requests with this handler, replacing any earlier one. A test can
   * swap in a freshly built app on the same origin to simulate a restart.
   */
  serve(handler: RequestListener): void;
};

/**
 * Listen first and build the handler afterwards. An OpenID provider needs
 * its issuer URL, port included, before it can be created.
 */
export async function listenOnLoopback(): Promise<LoopbackServer> {
  let current: RequestListener | undefined;
  const server = createServer((request, response) => {
    if (current === undefined) {
      response.statusCode = 503;
      response.end();
      return;
    }
    current(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the server to listen on a TCP port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    serve(handler) {
      current = handler;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
