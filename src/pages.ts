/**
 * The broker's few HTML pages. Every value is escaped, because a client's
 * name is chosen by whoever registers the client.
 */

/**
 * Headers for every page: no scripts or outside resources, and no framing,
 * so another site can't overlay the consent buttons to trick a click.
 */
export const pageHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "content-type": "text/html; charset=utf-8",
} as const satisfies Record<string, string>;

export type ConsentPage = {
  readonly abortPath: string;
  readonly clientId: string;
  readonly clientName: string | undefined;
  readonly confirmPath: string;
  readonly webId: string;
};

/** Ask the person to confirm an app may act as their WebID. */
export function renderConsentPage(page: ConsentPage): string {
  // The name is the client's claim about itself, so the ID is always shown.
  const client =
    page.clientName === undefined
      ? `<code>${escapeHtml(page.clientId)}</code>`
      : `${escapeHtml(page.clientName)} (<code>${escapeHtml(page.clientId)}</code>)`;
  return layout({
    body: `<h1>Allow this app to use your WebID?</h1>
<p>${client} wants to act as <code>${escapeHtml(page.webId)}</code>.</p>
<form method="post" action="${escapeHtml(page.confirmPath)}"><button type="submit">Allow</button></form>
<form method="post" action="${escapeHtml(page.abortPath)}"><button type="submit">Deny</button></form>`,
    title: "Allow this app?",
  });
}

/** A page for a login that can't go on. It never says why accounts differ. */
export function renderErrorPage(page: {
  readonly heading: string;
  readonly message: string;
}): string {
  return layout({
    body: `<h1>${escapeHtml(page.heading)}</h1>
<p>${escapeHtml(page.message)}</p>`,
    title: page.heading,
  });
}

/** Escape text for use in HTML content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(options: { readonly body: string; readonly title: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5}form{display:inline-block;margin-right:1rem}button{font-size:1rem;padding:.5rem 1rem}</style>
</head>
<body>
${options.body}
</body>
</html>
`;
}
