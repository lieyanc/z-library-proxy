import { searchOpenCatalogs } from "./catalog.js";
import { ChallengeRequiredError, fetchUpstream, storeSessionCookies } from "./challenge.js";
import { COVER_HOSTS, parseZlibBook, parseZlibFormats, parseZlibSearch } from "./zlib.js";
import {
  isCidAllowed,
  isValidCid,
  normalizeIpfsPath,
  probeIpfsGateways,
  proxyIpfsDownload,
} from "./ipfs.js";
import {
  APP_CSS,
  APP_JS,
  PATCH_CSS,
  PATCH_JS,
  renderHomePage,
  renderSourceToolbar,
  THEME_INIT_SCRIPT_SHA256,
} from "./ui.js";

const DEFAULT_UPSTREAM_ORIGIN = "https://z-lib.sk";
const INTERNAL_PREFIX = "/__z/";

const URL_ATTRIBUTES = [
  ["a[href]", "href"],
  ["area[href]", "href"],
  ["audio[src]", "src"],
  ["base[href]", "href"],
  ["blockquote[cite]", "cite"],
  ["embed[src]", "src"],
  ["form[action]", "action"],
  ["iframe[src]", "src"],
  ["img[src]", "src"],
  ["input[src]", "src"],
  ["link[href]", "href"],
  ["object[data]", "data"],
  ["q[cite]", "cite"],
  ["script[src]", "src"],
  ["source[src]", "src"],
  ["track[src]", "src"],
  ["video[poster]", "poster"],
  ["video[src]", "src"],
];

const REQUEST_HEADERS_TO_REMOVE = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "forwarded",
  "host",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

function parseUpstreamOrigin(value) {
  const upstream = new URL(value || DEFAULT_UPSTREAM_ORIGIN);

  if (
    upstream.protocol !== "https:" ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error("UPSTREAM_ORIGIN must be an HTTPS origin without a path, query, or hash");
  }

  return upstream;
}

export function buildUpstreamUrl(requestUrl, upstream) {
  const target = new URL(upstream);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  return target;
}

export function rewriteAbsoluteUrl(value, upstream, proxy) {
  if (!/^https?:\/\//i.test(value) && !value.startsWith("//")) {
    return value;
  }

  try {
    const target = new URL(value, upstream);
    if (target.origin !== upstream.origin) {
      return value;
    }

    return `${proxy.origin}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return value;
  }
}

function replaceOriginReferences(value, upstream, proxy) {
  const boundary = "(?=$|[\\s\\/\\?#:;'\"<>,)])";
  const origin = new RegExp(`${escapeRegExp(upstream.origin)}${boundary}`, "gi");
  const protocolRelative = new RegExp(`${escapeRegExp(`//${upstream.host}`)}${boundary}`, "gi");

  return value
    .replace(origin, () => proxy.origin)
    .replace(protocolRelative, () => `//${proxy.host}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteSetCookie(cookie, upstreamHostname) {
  return cookie.replace(/;\s*Domain=([^;]+)/gi, (attribute, domain) => {
    const normalizedDomain = domain.trim().replace(/^\./, "").toLowerCase();
    return normalizedDomain === upstreamHostname.toLowerCase() ? "" : attribute;
  });
}

function getSetCookies(headers) {
  if (typeof headers.getAll === "function") {
    return headers.getAll("Set-Cookie");
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const cookie = headers.get("Set-Cookie");
  return cookie ? [cookie] : [];
}

function rewriteRequestHeaders(headers, requestUrl, upstream) {
  for (const name of REQUEST_HEADERS_TO_REMOVE) {
    headers.delete(name);
  }

  const origin = headers.get("Origin");
  if (origin === requestUrl.origin) {
    headers.set("Origin", upstream.origin);
  }

  const referer = headers.get("Referer");
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.origin === requestUrl.origin) {
        refererUrl.protocol = upstream.protocol;
        refererUrl.host = upstream.host;
        headers.set("Referer", refererUrl.toString());
      }
    } catch {
      headers.delete("Referer");
    }
  }

  headers.set("X-Forwarded-Host", requestUrl.host);
  headers.set("X-Forwarded-Proto", requestUrl.protocol.slice(0, -1));
}

function rewriteResponseHeaders(response, upstream, proxy) {
  const headers = new Headers(response.headers);

  for (const name of [
    "Access-Control-Allow-Origin",
    "Content-Location",
    "Content-Security-Policy",
    "Content-Security-Policy-Report-Only",
    "Link",
    "Location",
    "Refresh",
  ]) {
    const value = headers.get(name);
    if (value) {
      headers.set(name, replaceOriginReferences(value, upstream, proxy));
    }
  }

  const cookies = getSetCookies(response.headers);
  if (cookies.length > 0) {
    headers.delete("Set-Cookie");
    for (const cookie of cookies) {
      headers.append("Set-Cookie", rewriteSetCookie(cookie, upstream.hostname));
    }
  }

  return headers;
}

class AttributeRewriter {
  constructor(attribute, upstream, proxy) {
    this.attribute = attribute;
    this.upstream = upstream;
    this.proxy = proxy;
  }

  element(element) {
    const value = element.getAttribute(this.attribute);
    if (value !== null) {
      element.setAttribute(this.attribute, rewriteAbsoluteUrl(value, this.upstream, this.proxy));
    }
  }
}

class OriginReferenceRewriter {
  constructor(attribute, upstream, proxy) {
    this.attribute = attribute;
    this.upstream = upstream;
    this.proxy = proxy;
  }

  element(element) {
    const value = element.getAttribute(this.attribute);
    if (value !== null) {
      element.setAttribute(
        this.attribute,
        replaceOriginReferences(value, this.upstream, this.proxy),
      );
    }
  }
}

class PatchHeadHandler {
  element(element) {
    element.append(
      '<link rel="stylesheet" href="/__z/assets/patch.css"><script src="/__z/assets/patch.js" defer></script>',
      { html: true },
    );
  }
}

class PatchBodyHandler {
  constructor(searchPage, query) {
    this.searchPage = searchPage;
    this.query = query;
  }

  element(element) {
    const currentClasses = element.getAttribute("class") || "";
    const patchClasses = this.searchPage ? "zp-proxy-page zp-search-page" : "zp-proxy-page";
    element.setAttribute("class", `${currentClasses} ${patchClasses}`.trim());

    if (this.searchPage) {
      element.prepend(renderSourceToolbar(this.query), { html: true });
    }
  }
}

function sourceSearchDetails(requestUrl) {
  if (requestUrl.pathname.startsWith("/s/")) {
    const encodedQuery = requestUrl.pathname.slice(3).split("/")[0];
    try {
      return { isSearchPage: true, query: decodeURIComponent(encodedQuery) };
    } catch {
      return { isSearchPage: true, query: encodedQuery };
    }
  }

  if (/^\/search(?:\/|$)/.test(requestUrl.pathname)) {
    return {
      isSearchPage: true,
      query: requestUrl.searchParams.get("q") || requestUrl.searchParams.get("query") || "",
    };
  }

  return { isSearchPage: false, query: "" };
}

function rewriteHtml(response, upstream, requestUrl) {
  let rewriter = new HTMLRewriter();
  const searchDetails = sourceSearchDetails(requestUrl);

  for (const [selector, attribute] of URL_ATTRIBUTES) {
    rewriter = rewriter.on(selector, new AttributeRewriter(attribute, upstream, requestUrl));
  }

  rewriter = rewriter
    .on("img[srcset]", new OriginReferenceRewriter("srcset", upstream, requestUrl))
    .on("source[srcset]", new OriginReferenceRewriter("srcset", upstream, requestUrl))
    .on("meta[content]", new OriginReferenceRewriter("content", upstream, requestUrl))
    .on("*[style]", new OriginReferenceRewriter("style", upstream, requestUrl))
    .on("head", new PatchHeadHandler())
    .on("body", new PatchBodyHandler(searchDetails.isSearchPage, searchDetails.query));

  return rewriter.transform(response);
}

function responseWithBody(body, contentType, cacheControl = "public, max-age=86400") {
  return new Response(body, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function methodNotAllowed(allowedMethods = "GET, HEAD") {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allowedMethods },
  });
}

function buildIpfsProxyUrl(cid, path, filename, gatewayId) {
  const searchParams = new URLSearchParams();
  if (path) {
    searchParams.set("path", path);
  }
  if (filename) {
    searchParams.set("filename", filename);
  }
  searchParams.set("gateway", gatewayId);
  return `/__z/ipfs/${cid}?${searchParams}`;
}

async function handleInternalRequest(request, requestUrl, env) {
  if (requestUrl.pathname === "/__z/api/challenge") {
    return handleChallengeSubmission(request, env);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  if (requestUrl.pathname === "/__z/assets/app.css") {
    return responseWithBody(request.method === "HEAD" ? null : APP_CSS, "text/css; charset=utf-8");
  }
  if (requestUrl.pathname === "/__z/assets/app.js") {
    return responseWithBody(
      request.method === "HEAD" ? null : APP_JS,
      "text/javascript; charset=utf-8",
    );
  }
  if (requestUrl.pathname === "/__z/assets/patch.css") {
    return responseWithBody(
      request.method === "HEAD" ? null : PATCH_CSS,
      "text/css; charset=utf-8",
    );
  }
  if (requestUrl.pathname === "/__z/assets/patch.js") {
    return responseWithBody(
      request.method === "HEAD" ? null : PATCH_JS,
      "text/javascript; charset=utf-8",
    );
  }

  if (requestUrl.pathname.startsWith("/__z/ipfs/")) {
    const cid = requestUrl.pathname.slice("/__z/ipfs/".length);
    if (!isValidCid(cid) || cid.includes("/")) {
      return new Response("Invalid CID", { status: 400 });
    }
    if (!isCidAllowed(cid, env?.ALLOWED_IPFS_CIDS)) {
      return new Response("CID is not authorized for proxy download", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }

    try {
      return proxyIpfsDownload(request, {
        cid,
        filename: requestUrl.searchParams.get("filename") || "",
        gatewayId: requestUrl.searchParams.get("gateway") || "",
        path: requestUrl.searchParams.get("path") || "",
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return new Response("Invalid IPFS download request", { status: 400 });
      }
      throw error;
    }
  }

  if (requestUrl.pathname.startsWith("/__z/api/") && request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  if (requestUrl.pathname === "/__z/api/search") {
    const query = (requestUrl.searchParams.get("q") || "").trim();
    if (!query) {
      return jsonResponse({ error: "Missing search query" }, { status: 400 });
    }

    const results = await searchOpenCatalogs(query);
    return jsonResponse(results, {
      headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
    });
  }

  if (requestUrl.pathname === "/__z/api/zsearch") {
    const query = (requestUrl.searchParams.get("q") || "").trim();
    if (!query) {
      return jsonResponse({ error: "Missing search query" }, { status: 400 });
    }
    const page = Math.min(Math.max(Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1, 1), 100);

    const results = await searchZlibCatalog(query, page, env);
    if (results.challenge) {
      return jsonResponse(results, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return jsonResponse(results, {
      headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
    });
  }

  if (requestUrl.pathname === "/__z/api/zbook") {
    const bookPath = requestUrl.searchParams.get("path") || "";
    if (!/^\/book\/[A-Za-z0-9]+\/[A-Za-z0-9._-]*\.html$/.test(bookPath)) {
      return jsonResponse({ error: "Invalid book path" }, { status: 400 });
    }

    const book = await fetchZlibBook(bookPath, env);
    if (book?.challenge) {
      return jsonResponse(book, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!book) {
      return jsonResponse({ error: "Book page could not be parsed" }, { status: 502 });
    }
    return jsonResponse(
      { ...book, accountConfigured: Boolean((env.ZLIB_ACCOUNT_COOKIES || "").trim()) },
      {
        headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=900" },
      },
    );
  }

  if (requestUrl.pathname === "/__z/api/zformats") {
    const bookId = requestUrl.searchParams.get("id") || "";
    if (!/^\d{1,12}$/.test(bookId)) {
      return jsonResponse({ error: "Invalid book id" }, { status: 400 });
    }

    const result = await fetchZlibFormats(bookId, env);
    if (result?.challenge) {
      return jsonResponse(result, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!result) {
      return jsonResponse({ error: "Formats could not be fetched" }, { status: 502 });
    }
    return jsonResponse(result, {
      headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=900" },
    });
  }

  if (requestUrl.pathname === "/__z/cover") {
    return proxyCoverImage(request, requestUrl, env);
  }

  if (requestUrl.pathname.startsWith("/__z/dl/")) {
    return handleAccountDownload(request, requestUrl, env);
  }

  if (requestUrl.pathname === "/__z/api/ipfs-probe") {
    const cid = requestUrl.searchParams.get("cid") || "";
    if (!isValidCid(cid)) {
      return jsonResponse({ error: "Invalid CID" }, { status: 400 });
    }

    let path;
    try {
      path = normalizeIpfsPath(requestUrl.searchParams.get("path") || "");
    } catch {
      return jsonResponse({ error: "Invalid IPFS path" }, { status: 400 });
    }

    const filename = requestUrl.searchParams.get("filename") || "";
    const proxyAllowed = isCidAllowed(cid, env?.ALLOWED_IPFS_CIDS);
    const gateways = (await probeIpfsGateways(cid, path)).map((gateway) => ({
      ...gateway,
      proxyUrl: proxyAllowed
        ? buildIpfsProxyUrl(cid, path, filename, gateway.id)
        : null,
    }));
    return jsonResponse(
      { cid, gateways, path, proxyAllowed },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return new Response("Not Found", { status: 404 });
}

const CHALLENGE_TOKEN_RE = /^[0-9A-Fa-f]{40}\d{1,10}$/;

// Accepts a PoW solution computed by the visitor's browser and stores it in
// the upstream session jar for subsequent API/proxy fetches.
async function handleChallengeSubmission(request, env) {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof payload?.token === "string" ? payload.token : "";
  const seconds = Number(payload?.seconds);
  if (
    !CHALLENGE_TOKEN_RE.test(token) ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > 600
  ) {
    return jsonResponse({ error: "Invalid challenge solution" }, { status: 400 });
  }

  let upstream;
  try {
    upstream = parseUpstreamOrigin(env.UPSTREAM_ORIGIN);
  } catch (error) {
    console.error(error);
    return new Response("Worker configuration error", { status: 500 });
  }

  storeSessionCookies(upstream.origin, {
    c_token: token,
    c_time: seconds.toFixed(3),
  });
  return jsonResponse({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

const ZLIB_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

async function fetchZlibPage(pathAndQuery, env) {
  const upstream = parseUpstreamOrigin(env.UPSTREAM_ORIGIN);
  const response = await fetchUpstream(`${upstream.origin}${pathAndQuery}`, {
    headers: ZLIB_FETCH_HEADERS,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  }, { delegateChallenge: true });
  if (!response.ok) {
    throw new Error(`Upstream catalog returned ${response.status}`);
  }
  return response.text();
}

async function searchZlibCatalog(query, page, env) {
  const normalizedQuery = query.trim().slice(0, 200);
  let results = [];
  let ok = false;
  let error = null;
  let challenge = null;
  try {
    const pageSuffix = page > 1 ? `?page=${page}` : "";
    const html = await fetchZlibPage(`/s/${encodeURIComponent(normalizedQuery)}${pageSuffix}`, env);
    results = parseZlibSearch(html);
    ok = true;
  } catch (caught) {
    if (caught instanceof ChallengeRequiredError) {
      challenge = caught.challenge;
    } else {
      error = String(caught);
      console.error("Z-Library search failed", caught);
    }
  }

  return {
    query: normalizedQuery,
    page,
    results,
    challenge,
    sources: { zlib: { ok, count: results.length, error } },
  };
}

async function fetchZlibBook(bookPath, env) {
  try {
    const html = await fetchZlibPage(bookPath, env);
    return parseZlibBook(html, bookPath);
  } catch (error) {
    if (error instanceof ChallengeRequiredError) {
      return { challenge: error.challenge };
    }
    console.error("Z-Library book fetch failed", error);
    return null;
  }
}

// Lists the other downloadable formats of a book via the upstream JSON
// endpoint /papi/book/<id>/formats (the "Download" dropdown on book pages).
// The listing itself does not require an account session; downloads still go
// through /__z/dl/, which does.
async function fetchZlibFormats(bookId, env) {
  try {
    const upstream = parseUpstreamOrigin(env.UPSTREAM_ORIGIN);
    const accountCookies = (env.ZLIB_ACCOUNT_COOKIES || "").trim();
    const response = await fetchUpstream(
      `${upstream.origin}/papi/book/${bookId}/formats`,
      {
        headers: {
          ...ZLIB_FETCH_HEADERS,
          Accept: "application/json, */*;q=0.8",
          Referer: `${upstream.origin}/book/`,
          ...(accountCookies ? { Cookie: accountCookies } : {}),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      },
      { delegateChallenge: true },
    );
    if (!response.ok) {
      throw new Error(`Upstream formats returned ${response.status}`);
    }
    return { bookId, formats: parseZlibFormats(await response.text()) };
  } catch (error) {
    if (error instanceof ChallengeRequiredError) {
      return { challenge: error.challenge };
    }
    console.error("Z-Library formats fetch failed", error);
    return null;
  }
}

// Resolves /dl/<hash> with the configured account session (used only here)
// and streams the CDN file through the worker. The upstream answers 302 to a
// signed CDN URL; we follow it manually and proxy the bytes so visitors never
// contact third-party hosts directly.
async function handleAccountDownload(request, requestUrl, env) {
  const hash = requestUrl.pathname.slice("/__z/dl/".length);
  if (!/^[A-Za-z0-9]+$/.test(hash)) {
    return new Response("Invalid download path", { status: 400 });
  }

  const accountCookies = (env.ZLIB_ACCOUNT_COOKIES || "").trim();
  if (!accountCookies) {
    return new Response("Account session is not configured", { status: 501 });
  }

  let upstream;
  try {
    upstream = parseUpstreamOrigin(env.UPSTREAM_ORIGIN);
  } catch (error) {
    console.error(error);
    return new Response("Worker configuration error", { status: 500 });
  }

  let dlResponse;
  try {
    dlResponse = await fetchUpstream(`${upstream.origin}/dl/${hash}`, {
      method: "GET",
      headers: { ...ZLIB_FETCH_HEADERS, Cookie: accountCookies },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    console.error("Download resolution failed", error);
    return new Response("Bad Gateway", { status: 502 });
  }

  if (dlResponse.status === 200) {
    return new Response("源站账户未登录或当日下载额度已用尽", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const location = dlResponse.headers.get("Location");
  if (dlResponse.status !== 302 || !location) {
    return new Response("Bad Gateway", { status: 502 });
  }

  const cdnHeaders = { "User-Agent": ZLIB_FETCH_HEADERS["User-Agent"] };
  const range = request.headers.get("Range");
  if (range && request.method === "GET") {
    cdnHeaders.Range = range;
  }

  const fetchCdn = (headers) =>
    fetch(location, { method: request.method, headers, redirect: "manual" });

  let cdnResponse;
  try {
    cdnResponse = await fetchCdn(cdnHeaders);
    if (cdnResponse.status === 416 && cdnHeaders.Range) {
      // The CDN only supports open-ended ranges; retry as a plain full GET.
      await cdnResponse.body?.cancel().catch(() => {});
      delete cdnHeaders.Range;
      cdnResponse = await fetchCdn(cdnHeaders);
    }
  } catch (error) {
    console.error("CDN fetch failed", error);
    return new Response("Bad Gateway", { status: 502 });
  }
  if (!cdnResponse.ok) {
    return new Response("Bad Gateway", { status: 502 });
  }

  let filename = "";
  try {
    filename = new URL(location).searchParams.get("filename") || "";
  } catch {
    // Keep the CDN Content-Disposition as the fallback below.
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    cdnResponse.headers.get("Content-Type") || "application/octet-stream",
  );
  for (const name of ["Content-Length", "Accept-Ranges", "Content-Range"]) {
    const value = cdnResponse.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  if (filename) {
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  } else if (cdnResponse.headers.get("Content-Disposition")) {
    headers.set("Content-Disposition", cdnResponse.headers.get("Content-Disposition"));
  }
  headers.set("Cache-Control", "private, no-store");

  return new Response(request.method === "HEAD" ? null : cdnResponse.body, {
    status: cdnResponse.status,
    headers,
  });
}

async function proxyCoverImage(request, requestUrl, env) {
  const target = requestUrl.searchParams.get("u") || "";
  let url;
  try {
    url = new URL(target);
  } catch {
    return new Response("Invalid cover URL", { status: 400 });
  }
  if (url.protocol !== "https:" || !COVER_HOSTS.has(url.hostname)) {
    return new Response("Cover host is not allowed", { status: 403 });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchUpstream(url.toString(), {
      method: request.method,
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }

  const contentType = upstreamResponse.headers.get("Content-Type") || "";
  if (!upstreamResponse.ok || !contentType.toLowerCase().startsWith("image/")) {
    return new Response("Cover not found", { status: upstreamResponse.ok ? 404 : upstreamResponse.status });
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(request.method === "HEAD" ? null : upstreamResponse.body, {
    status: 200,
    headers,
  });
}

function handleHomeRequest(request, requestUrl) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const query = requestUrl.searchParams.get("q") || "";
  const body = request.method === "HEAD" ? null : renderHomePage(query);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'self'; connect-src 'self'; img-src 'self' https: data:; script-src 'self' 'sha256-${THEME_INIT_SCRIPT_SHA256}'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function proxyRequest(request, env) {
  let upstream;
  try {
    upstream = parseUpstreamOrigin(env.UPSTREAM_ORIGIN);
  } catch (error) {
    console.error(error);
    return new Response("Worker configuration error", { status: 500 });
  }

  const requestUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(requestUrl, upstream);
  const headers = new Headers(request.headers);
  rewriteRequestHeaders(headers, requestUrl, upstream);

  // Buffer the body so the resilient fetcher may retry the request.
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  let upstreamResponse;
  try {
    upstreamResponse = await fetchUpstream(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (error) {
    console.error("Upstream request failed", error);
    return new Response("Bad Gateway", { status: 502 });
  }

  const response = new Response(upstreamResponse.body, {
    headers: rewriteResponseHeaders(upstreamResponse, upstream, requestUrl),
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  });

  const contentType = response.headers.get("Content-Type") || "";
  if (request.method !== "HEAD" && contentType.toLowerCase().includes("text/html")) {
    return rewriteHtml(response, upstream, requestUrl);
  }

  return response;
}

export default {
  fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname.startsWith(INTERNAL_PREFIX)) {
      return handleInternalRequest(request, requestUrl, env);
    }

    if (requestUrl.pathname === "/") {
      const homeResponse = handleHomeRequest(request, requestUrl);
      if (homeResponse) {
        return homeResponse;
      }
    }

    return proxyRequest(request, env);
  },
};
