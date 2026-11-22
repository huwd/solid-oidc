/**
 * A minimal browser for login tests: it follows redirects and keeps cookies.
 *
 * Cookies are kept per origin, port included, so two providers on 127.0.0.1
 * keep separate cookies as they would on separate hosts. Cookie paths and
 * attributes are ignored, which is enough for these tests.
 */
export type Browser = {
  visit(url: string | URL, options?: VisitOptions): Promise<Visit>;
};

export type VisitOptions = {
  /** Form fields to post, URL-encoded. Only the first request carries them. */
  readonly form?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "POST" | undefined;
  /** Change a redirect before following it, to test tampered requests. */
  readonly rewrite?: (location: URL) => URL;
  /** Stop instead of following a redirect here, such as an app's callback. */
  readonly stopAt?: (location: URL) => boolean;
};

export type Visit = {
  readonly body: string;
  /** The headers of the last response. */
  readonly headers: Headers;
  readonly status: number;
  /** The last URL fetched, or the redirect it stopped at. */
  readonly url: URL;
};

const redirectsMax = 20;

export function createBrowser(): Browser {
  const jar = new Map<string, Map<string, string>>();

  function cookieHeader(url: URL): string {
    const cookies = jar.get(url.origin) ?? new Map<string, string>();
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function store(url: URL, response: Response): void {
    const cookies = jar.get(url.origin) ?? new Map<string, string>();
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) =>
        /^\s*(max-age=0|expires=.*1970)/i.test(attribute),
      );
      if (value === "" || expired) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
    jar.set(url.origin, cookies);
  }

  return {
    async visit(start, options = {}) {
      let url = new URL(start);
      let method = options.method ?? "GET";
      let body: URLSearchParams | null =
        options.form === undefined ? null : new URLSearchParams(options.form);
      for (let redirect = 0; redirect < redirectsMax; redirect += 1) {
        const response = await fetch(url, {
          body,
          headers: { cookie: cookieHeader(url) },
          method,
          redirect: "manual",
        });
        store(url, response);
        const location = response.headers.get("location");
        if (location === null || response.status < 300 || response.status > 399) {
          return {
            body: await response.text(),
            headers: response.headers,
            status: response.status,
            url,
          };
        }
        await response.body?.cancel();
        const next = (options.rewrite ?? ((same) => same))(new URL(location, url));
        if (options.stopAt?.(next) === true) {
          return { body: "", headers: response.headers, status: response.status, url: next };
        }
        url = next;
        method = "GET";
        body = null;
      }
      throw new Error(`More than ${redirectsMax} redirects from ${start}`);
    },
  };
}
