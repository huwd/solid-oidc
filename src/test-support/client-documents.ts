import { appOrigin } from "./login-harness.ts";

/**
 * A fake `fetch` that serves Client ID Documents from memory, so tests need
 * no HTTPS server, and records every request it receives.
 */
export type ClientDocuments = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly Request[];
  /** Answer requests for this URL. */
  serve(url: string, respond: (request: Request) => Response | Promise<Response>): void;
};

export function createClientDocuments(): ClientDocuments {
  const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
  const requests: Request[] = [];

  return {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const respond = handlers.get(request.url);
      if (respond === undefined) {
        throw new TypeError(`fetch failed: nothing at ${request.url}`);
      }
      return respond(request);
    },
    requests,
    serve(url, respond) {
      handlers.set(url, respond);
    },
  };
}

/** A Client ID Document as a Solid app publishes it, in JSON-LD. */
export function solidAppDocument(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
    client_id: clientId,
    client_name: "Solid Test App",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [`${appOrigin}/callback`],
    response_types: ["code"],
    scope: "openid webid offline_access",
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

/** Respond with a JSON-LD body, as a Solid app's server does. */
export function jsonLd(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/ld+json", ...headers },
  });
}
