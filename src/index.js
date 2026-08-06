import { searchOpenCatalogs } from "./catalog.js";
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

  const requestWithUpstreamUrl = new Request(upstreamUrl, request);
  const upstreamRequest = new Request(requestWithUpstreamUrl, {
    headers,
    redirect: "manual",
  });

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest);
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
