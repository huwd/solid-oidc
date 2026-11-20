import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeHtml, renderConsentPage, renderErrorPage } from "./pages.ts";

describe("escapeHtml", () => {
  it("escapes every character that could end text or an attribute", () => {
    assert.equal(
      escapeHtml(`<a href="x" title='y'>&</a>`),
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("renderConsentPage", () => {
  it("escapes a hostile client name and still shows the client ID", () => {
    const page = renderConsentPage({
      abortPath: "/interaction/u/abort",
      clientId: "https://app.example.test/id",
      clientName: '<script>alert("x")</script>',
      confirmPath: "/interaction/u/confirm",
      webId: "https://alice.example.test/profile/card#me",
    });

    assert.ok(!page.includes("<script>"), "expected the client name to be escaped");
    assert.ok(page.includes("<code>https://app.example.test/id</code>"));
  });
});

describe("renderErrorPage", () => {
  it("escapes the heading and message", () => {
    const page = renderErrorPage({ heading: "<h>", message: "<m>" });

    assert.ok(page.includes("<h1>&lt;h&gt;</h1>"));
    assert.ok(page.includes("<p>&lt;m&gt;</p>"));
  });
});
