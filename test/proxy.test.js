import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker, {
  buildUpstreamUrl,
  rewriteAbsoluteUrl,
  rewriteSetCookie,
} from "../src/index.js";
import {
  PATCH_JS,
  THEME_INIT_SCRIPT,
  THEME_INIT_SCRIPT_SHA256,
} from "../src/ui.js";

const upstream = new URL("https://z-lib.sk");
const proxy = new URL("https://books.example.com");

test("serves the minimal search home without contacting the upstream", async () => {
  const response = await worker.fetch(
    new Request("https://books.example.com/?q=alice"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'self'/);
  assert.match(html, /<div id="root" data-query="alice"><\/div>/);
  assert.match(html, /\/__z\/assets\/app\.js/);
  assert.match(html, /\/__z\/assets\/app\.css/);
});

test("keeps the theme init script in sync with its CSP hash", async () => {
  const digest = createHash("sha256").update(THEME_INIT_SCRIPT).digest("base64");
  assert.equal(digest, THEME_INIT_SCRIPT_SHA256);

  const response = await worker.fetch(
    new Request("https://books.example.com/"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  const html = await response.text();

  assert.ok(
    response.headers
      .get("Content-Security-Policy")
      .includes(`'sha256-${THEME_INIT_SCRIPT_SHA256}'`),
  );
  assert.ok(html.includes(`<script>${THEME_INIT_SCRIPT}</script>`));
});

test("rejects invalid CIDs before probing a gateway", async () => {
  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/ipfs-probe?cid=..%2F..%2Fsecret"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid CID" });
});

test("rejects valid but unauthorized IPFS proxy downloads", async () => {
  const cid = "QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX";
  const response = await worker.fetch(
    new Request(`https://books.example.com/__z/ipfs/${cid}`),
    { ALLOWED_IPFS_CIDS: "", UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "CID is not authorized for proxy download");
});

test("keeps the selected CID available when an IPFS probe fails", () => {
  assert.match(PATCH_JS, /addText\(body, 'zp-ipfs-cid', details\.cid\)/);
  assert.doesNotMatch(PATCH_JS, /if \(gateway\.ok\) \{/);
});

test("rewrites only absolute URLs for the configured upstream", () => {
  assert.equal(
    rewriteAbsoluteUrl("https://z-lib.sk/book/1?q=test#details", upstream, proxy),
    "https://books.example.com/book/1?q=test#details",
  );
  assert.equal(rewriteAbsoluteUrl("//z-lib.sk/static/app.js", upstream, proxy), "https://books.example.com/static/app.js");
  assert.equal(rewriteAbsoluteUrl("/book/1", upstream, proxy), "/book/1");
  assert.equal(rewriteAbsoluteUrl("https://cdn.example.com/app.js", upstream, proxy), "https://cdn.example.com/app.js");
});

test("removes only the upstream cookie domain", () => {
  assert.equal(
    rewriteSetCookie("session=abc; Domain=.z-lib.sk; Path=/; Secure", "z-lib.sk"),
    "session=abc; Path=/; Secure",
  );
  assert.equal(
    rewriteSetCookie("session=abc; Domain=accounts.example.com; Path=/", "z-lib.sk"),
    "session=abc; Domain=accounts.example.com; Path=/",
  );
});

test("keeps protocol-relative-looking paths on the configured upstream", () => {
  const target = buildUpstreamUrl(
    new URL("https://books.example.com//untrusted.example/path?q=test"),
    upstream,
  );

  assert.equal(target.origin, "https://z-lib.sk");
  assert.equal(target.pathname, "//untrusted.example/path");
  assert.equal(target.search, "?q=test");
});

test("forwards requests and rewrites same-origin response headers", async (context) => {
  const originalFetch = globalThis.fetch;
  let forwardedUrl;
  let forwardedInit;

  globalThis.fetch = async (url, init) => {
    forwardedUrl = url;
    forwardedInit = init;
    const headers = new Headers({
      Location: "https://z-lib.sk/login?next=%2Fbook%2F1",
    });
    headers.append("Set-Cookie", "session=abc; Domain=.z-lib.sk; Path=/; Secure; HttpOnly");
    return new Response(null, { status: 302, headers });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(
    new Request("https://books.example.com/book/1?ref=home", {
      headers: {
        Origin: "https://books.example.com",
        Referer: "https://books.example.com/search?q=worker",
      },
    }),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(forwardedUrl, "https://z-lib.sk/book/1?ref=home");
  assert.equal(forwardedInit.redirect, "manual");
  assert.equal(forwardedInit.headers.get("Origin"), "https://z-lib.sk");
  assert.equal(forwardedInit.headers.get("Referer"), "https://z-lib.sk/search?q=worker");
  assert.equal(forwardedInit.headers.get("X-Forwarded-Host"), "books.example.com");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://books.example.com/login?next=%2Fbook%2F1");
  assert.equal(
    response.headers.get("Set-Cookie"),
    "session=abc; Path=/; Secure; HttpOnly",
  );
});
