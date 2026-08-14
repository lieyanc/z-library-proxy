import { searchOpenCatalogs } from "./catalog.js";
import { ChallengeRequiredError, fetchUpstream } from "./challenge.js";
import { COVER_HOSTS, parseZlibBook, parseZlibFormats, parseZlibSearch } from "./zlib.js";
import {
  isCidAllowed,
  isValidCid,
  normalizeIpfsPath,
  probeIpfsGateways,
  proxyIpfsDownload,
} from "./ipfs.js";
import {
  activeOriginFromHealth,
  applyAutomaticSelection,
  applyManualSelection,
  configuredOrigins,
  readOriginHealth,
  scanOrigins,
  writeOriginHealth,
} from "./origin-health.js";
import {
  APP_CSS,
  APP_JS,
  ASSETS_VERSION,
  BUILD_COMMIT,
  PATCH_CSS,
  PATCH_JS,
  renderHomePage,
  renderSourceToolbar,
  THEME_INIT_SCRIPT_SHA256,
} from "./ui.js";

// z-lib.sk remains the configured fallback; health checks can select another
// configured mirror automatically when it responds faster and successfully.
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

function configuredFallbackOrigin(env) {
  return parseUpstreamOrigin(env?.UPSTREAM_ORIGIN).origin;
}

async function resolveUpstreamOrigin(env) {
  const fallback = configuredFallbackOrigin(env);
  const health = await readOriginHealth(env?.ORIGIN_HEALTH);
  const selected = activeOriginFromHealth(health, fallback) || fallback;
  return parseUpstreamOrigin(selected);
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
  constructor(searchPage, query, upstreamHost) {
    this.searchPage = searchPage;
    this.query = query;
    this.upstreamHost = upstreamHost;
  }

  element(element) {
    const currentClasses = element.getAttribute("class") || "";
    const patchClasses = this.searchPage ? "zp-proxy-page zp-search-page" : "zp-proxy-page";
    element.setAttribute("class", `${currentClasses} ${patchClasses}`.trim());

    if (this.searchPage) {
      element.prepend(renderSourceToolbar(this.query, this.upstreamHost), { html: true });
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
    .on("body", new PatchBodyHandler(searchDetails.isSearchPage, searchDetails.query, upstream.host));

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

// In-flight upstream searches, keyed by the canonical cache key, so
// concurrent identical searches share one upstream fetch instead of
// multiplying the request rate the upstream rate-limiter sees.
const inflightZSearchRequests = new Map();
let inflightOriginScan = null;

function inflightZSearch(key, task) {
  const existing = inflightZSearchRequests.get(key);
  if (existing) {
    return existing;
  }
  const promise = task().finally(() => {
    inflightZSearchRequests.delete(key);
  });
  inflightZSearchRequests.set(key, promise);
  return promise;
}

async function runOriginScan(env) {
  if (inflightOriginScan) {
    return inflightOriginScan;
  }

  const previousHealthPromise = readOriginHealth(env?.ORIGIN_HEALTH);
  inflightOriginScan = Promise.all([scanOrigins(env), previousHealthPromise])
    .then(([payload, previous]) =>
      applyAutomaticSelection(payload, previous, env?.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN),
    )
    .then(async (payload) => {
      const persisted = Boolean(env?.ORIGIN_HEALTH);
      const result = { ...payload, persisted };
      if (persisted) {
        await writeOriginHealth(env.ORIGIN_HEALTH, result);
      }
      return result;
    })
    .finally(() => {
      inflightOriginScan = null;
    });
  return inflightOriginScan;
}

function emptyOriginHealth(env) {
  const origins = configuredOrigins(env);
  let fallback = null;
  try {
    fallback = configuredFallbackOrigin(env);
  } catch {
    fallback = new URL(DEFAULT_UPSTREAM_ORIGIN).origin;
  }
  return {
    checkedAt: null,
    origins,
    results: [],
    activeOrigin: activeOriginFromHealth({ origins }, fallback),
    selectionMode: "auto",
    selectedAt: null,
  };
}

function currentOriginHealth(env, stored) {
  const fallback = (() => {
    try {
      return configuredFallbackOrigin(env);
    } catch {
      return new URL(DEFAULT_UPSTREAM_ORIGIN).origin;
    }
  })();
  const origins = configuredOrigins(env);
  const base = stored && typeof stored === "object" ? stored : emptyOriginHealth(env);
  const results = Array.isArray(base.results)
    ? base.results.filter((result) => origins.includes(result?.origin))
    : [];
  const payload = { ...base, origins, results };
  const activeOrigin = activeOriginFromHealth(payload, fallback);
  const manual = payload.selectionMode === "manual" && origins.includes(activeOrigin);
  return {
    ...payload,
    activeOrigin,
    selectionMode: manual ? "manual" : "auto",
    persisted: Boolean(env?.ORIGIN_HEALTH),
  };
}

async function handleOriginSelection(request, env) {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }
  if (!env?.ORIGIN_HEALTH) {
    return jsonResponse(
      { error: "Origin selection requires the ORIGIN_HEALTH KV binding" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const auto = body?.mode === "auto" || body?.origin === null || body?.origin === "";
  if (!auto && typeof body?.origin !== "string") {
    return jsonResponse({ error: "Origin must be a configured HTTPS origin" }, { status: 400 });
  }

  const stored = await readOriginHealth(env.ORIGIN_HEALTH);
  const base = currentOriginHealth(env, stored);
  try {
    const selected = applyManualSelection(base, auto ? null : body.origin, env.UPSTREAM_ORIGIN);
    const result = { ...selected, persisted: true };
    await writeOriginHealth(env.ORIGIN_HEALTH, result);
    return jsonResponse(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid origin" }, { status: 400 });
  }
}

async function handleInternalRequest(request, requestUrl, env) {
  if (requestUrl.pathname === "/__z/api/challenge") {
    return handleChallengeSubmission(request, env);
  }

  if (requestUrl.pathname === "/__z/api/origins/scan") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    try {
      const payload = await runOriginScan(env);
      return jsonResponse(payload, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("Origin health scan failed", error);
      return jsonResponse({ error: "Origin scan failed" }, { status: 502 });
    }
  }

  if (requestUrl.pathname === "/__z/api/origins/select") {
    return handleOriginSelection(request, env);
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

  if (requestUrl.pathname === "/__z/api/version") {
    // Open tabs poll this to detect deploys and reload onto fresh assets.
    return jsonResponse(
      { version: ASSETS_VERSION, commit: BUILD_COMMIT },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (requestUrl.pathname === "/__z/api/origins") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return jsonResponse(currentOriginHealth(env, await readOriginHealth(env?.ORIGIN_HEALTH)), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (requestUrl.pathname === "/__z/api/search") {    const query = (requestUrl.searchParams.get("q") || "").trim();
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
    let cacheOrigin = env?.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN;
    try {
      cacheOrigin = (await resolveUpstreamOrigin(env)).origin;
    } catch {
      // Keep the normal search error handling for malformed upstream config.
    }
    const cacheKey = `https://zlib-cache.local/v${ASSETS_VERSION}/__z/api/zsearch?origin=${encodeURIComponent(cacheOrigin)}&q=${encodeURIComponent(query)}&page=${page}`;
    const cache = globalThis.caches?.default ?? null;

    // Serve a previously cached success without touching upstream — repeated
    // or popular queries stop consuming upstream rate-limit budget entirely.
    // Failures and challenges are never written to the cache.
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Merge concurrent identical searches into one upstream fetch.
    const results = await inflightZSearch(cacheKey, () =>
      searchZlibCatalog(query, page, env, readZlibSession(request), cacheOrigin),
    );
    if (results.challenge) {
      return jsonResponse(results, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const response = jsonResponse(results, {
      headers: {
        // Upstream failures (ok: false) must not be cached anywhere:
        // serving a cached failure would turn the next retry into an
        // instant, unrecoverable "搜索暂不可用". Successes are cached
        // both at the edge and in the Cache API (max-age=300).
        "Cache-Control": results.sources.zlib.ok
          ? "public, max-age=300, s-maxage=300, stale-while-revalidate=900"
          : "no-store",
      },
    });
    if (cache && results.sources.zlib.ok) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  }

  if (requestUrl.pathname === "/__z/api/zbook") {
    const bookPath = requestUrl.searchParams.get("path") || "";
    // Slugs of non-ASCII titles arrive percent-encoded (e.g. %E4%BD%99).
    if (!/^\/book\/[A-Za-z0-9]+\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*\.html$/.test(bookPath)) {
      return jsonResponse({ error: "Invalid book path" }, { status: 400 });
    }

    const book = await fetchZlibBook(bookPath, env, readZlibSession(request));
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

    const result = await fetchZlibFormats(bookId, env, readZlibSession(request));
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
const BSRV_RE = /^[a-f0-9]{16,64}$/i;

// The upstream anti-bot session (bsrv stickiness + PoW token) is only valid
// as a matched set, so it lives in this client-held cookie instead of the
// isolate-local jar — requests from one visitor may hit different isolates.
const ZLIB_SESSION_COOKIE = "z_zlib_session";
const ZLIB_SESSION_MAX_AGE = 1800;

function base64UrlEncode(value) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  return atob(value.replaceAll("-", "+").replaceAll("_", "/"));
}

function buildZlibSessionCookie(cookies) {
  return `${ZLIB_SESSION_COOKIE}=${base64UrlEncode(JSON.stringify(cookies))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ZLIB_SESSION_MAX_AGE}`;
}

// Reads and strictly validates the client-held upstream session. Returns a
// plain cookie object ({bsrv?, c_token?, c_time?}) or null.
function readZlibSession(request) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== ZLIB_SESSION_COOKIE) {
      continue;
    }
    try {
      const data = JSON.parse(base64UrlDecode(part.slice(eq + 1).trim()));
      const cookies = {};
      if (BSRV_RE.test(data?.bsrv || "")) {
        cookies.bsrv = data.bsrv;
      }
      if (CHALLENGE_TOKEN_RE.test(data?.c_token || "")) {
        cookies.c_token = data.c_token;
      }
      if (/^\d{1,4}(\.\d{1,3})?$/.test(data?.c_time || "")) {
        cookies.c_time = data.c_time;
      }
      return cookies.c_token ? cookies : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Shapes a delegated challenge for the browser: the PoW parameters plus the
// bsrv stickiness cookie from the same 503 response.
function challengePayload(error) {
  const payload = { ...error.challenge };
  if (error.cookies?.bsrv && BSRV_RE.test(error.cookies.bsrv)) {
    payload.bsrv = error.cookies.bsrv;
  }
  return payload;
}

// Accepts a PoW solution computed by the visitor's browser (paired with the
// bsrv the challenge was issued with) and stores it as a client-held session
// cookie that subsequent API requests forward upstream.
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
  const bsrv = typeof payload?.bsrv === "string" ? payload.bsrv : "";
  if (
    !CHALLENGE_TOKEN_RE.test(token) ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > 600 ||
    (bsrv && !BSRV_RE.test(bsrv))
  ) {
    return jsonResponse({ error: "Invalid challenge solution" }, { status: 400 });
  }

  const sessionCookies = { c_token: token, c_time: seconds.toFixed(3) };
  if (bsrv) {
    sessionCookies.bsrv = bsrv;
  }
  return jsonResponse(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": buildZlibSessionCookie(sessionCookies),
      },
    },
  );
}

const ZLIB_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

async function fetchZlibPage(pathAndQuery, env, session = null, upstreamOrigin = null) {
  const upstream = upstreamOrigin ? parseUpstreamOrigin(upstreamOrigin) : await resolveUpstreamOrigin(env);
  const response = await fetchUpstream(`${upstream.origin}${pathAndQuery}`, {
    headers: ZLIB_FETCH_HEADERS,
    redirect: "manual",
  }, { delegateChallenge: "solve", sessionCookies: session, timeoutMs: 20000 });
  if (!response.ok) {
    const error = new Error(`Upstream catalog returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function searchZlibCatalog(query, page, env, session = null, upstreamOrigin = null) {
  const normalizedQuery = query.trim().slice(0, 200);
  let results = [];
  let ok = false;
  let error = null;
  let challenge = null;
  let rateLimited = false;
  try {
    const pageSuffix = page > 1 ? `?page=${page}` : "";
    const html = await fetchZlibPage(
      `/s/${encodeURIComponent(normalizedQuery)}${pageSuffix}`,
      env,
      session,
      upstreamOrigin,
    );
    results = parseZlibSearch(html);
    ok = true;
  } catch (caught) {
    if (caught instanceof ChallengeRequiredError) {
      challenge = challengePayload(caught);
    } else {
      error = String(caught);
      rateLimited = caught?.status === 429;
      console.error("Z-Library search failed", caught);
    }
  }

  return {
    query: normalizedQuery,
    page,
    results,
    challenge,
    sources: { zlib: { ok, count: results.length, error, rateLimited } },
  };
}

async function fetchZlibBook(bookPath, env, session = null) {
  try {
    const html = await fetchZlibPage(bookPath, env, session);
    return parseZlibBook(html, bookPath);
  } catch (error) {
    if (error instanceof ChallengeRequiredError) {
      return { challenge: challengePayload(error) };
    }
    console.error("Z-Library book fetch failed", error);
    return null;
  }
}

// Lists the other downloadable formats of a book via the upstream JSON
// endpoint /papi/book/<id>/formats (the "Download" dropdown on book pages).
// The listing itself does not require an account session; downloads still go
// through /__z/dl/, which does.
async function fetchZlibFormats(bookId, env, session = null) {
  try {
    const upstream = await resolveUpstreamOrigin(env);
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
      },
      { delegateChallenge: "solve", sessionCookies: session, timeoutMs: 20000 },
    );
    if (!response.ok) {
      throw new Error(`Upstream formats returned ${response.status}`);
    }
    return { bookId, formats: parseZlibFormats(await response.text()) };
  } catch (error) {
    if (error instanceof ChallengeRequiredError) {
      return { challenge: challengePayload(error) };
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
    upstream = await resolveUpstreamOrigin(env);
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
    }, { timeoutMs: 20000 });
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
    }, { timeoutMs: 15000 });
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

async function upstreamHostOrDefault(env) {
  try {
    return (await resolveUpstreamOrigin(env)).host;
  } catch {
    return new URL(DEFAULT_UPSTREAM_ORIGIN).host;
  }
}

async function handleHomeRequest(request, requestUrl, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const query = requestUrl.searchParams.get("q") || "";
  const body = request.method === "HEAD" ? null : renderHomePage(query, await upstreamHostOrDefault(env));
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
    upstream = await resolveUpstreamOrigin(env);
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
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname.startsWith(INTERNAL_PREFIX)) {
      return handleInternalRequest(request, requestUrl, env);
    }

    if (requestUrl.pathname === "/") {
      const homeResponse = await handleHomeRequest(request, requestUrl, env);
      if (homeResponse) {
        return homeResponse;
      }
    }

    return proxyRequest(request, env);
  },

  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runOriginScan(env).catch((error) => {
        console.error("Scheduled origin health scan failed", error);
      }),
    );
  },
};
