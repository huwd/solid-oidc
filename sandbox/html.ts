import type Koa from "koa";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Send a page. `body` must already be escaped HTML. */
export function sendPage(
  context: Koa.Context,
  options: { readonly title: string; readonly body: string },
): void {
  context.type = "html";
  context.set("cache-control", "no-store");
  context.body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
pre{background:#f4f4f4;padding:1rem;overflow-x:auto;font-size:.85rem}
button{font-size:1rem;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}
.note{color:#555}
</style>
</head>
<body>
${options.body}
</body>
</html>
`;
}

/** Read an `application/x-www-form-urlencoded` body, up to 10 KiB. */
export async function readForm(context: Koa.Context): Promise<URLSearchParams> {
  const bytesMax = 10_240;
  let text = "";
  for await (const chunk of context.req) {
    text += String(chunk);
    if (text.length > bytesMax) {
      context.throw(413, "Form too large");
    }
  }
  return new URLSearchParams(text);
}
