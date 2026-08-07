const SAMPLE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 8000;

const GATEWAYS = [
  { id: "dweb", label: "dweb.link", baseUrl: "https://dweb.link/ipfs/" },
  { id: "ipfs", label: "ipfs.io", baseUrl: "https://ipfs.io/ipfs/" },
  { id: "w3s", label: "w3s.link", baseUrl: "https://w3s.link/ipfs/" },
];

const DOWNLOAD_REQUEST_HEADERS = ["If-Modified-Since", "If-None-Match", "Range"];
const DOWNLOAD_RESPONSE_HEADERS = [
  "Accept-Ranges",
  "Content-Length",
  "Content-Range",
  "Content-Type",
  "ETag",
  "Last-Modified",
];

export function isValidCid(value) {
  if (typeof value !== "string") {
    return false;
  }

  return (
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value) ||
    /^b[a-z2-7]{20,120}$/.test(value)
  );
}

export function isCidAllowed(cid, configuredCids) {
  if (!isValidCid(cid) || typeof configuredCids !== "string") {
    return false;
  }

  return configuredCids
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((allowedCid) => allowedCid === "*" || allowedCid === cid);
}

export function normalizeIpfsPath(value) {
  if (!value) {
    return "";
  }
  if (typeof value !== "string" || value.length > 1024 || value.includes("\\") || value.includes("\0")) {
    throw new TypeError("Invalid IPFS path");
  }

  const segments = value.replace(/^\/+/, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("Invalid IPFS path");
  }

  return segments.join("/");
}

function buildGatewayUrl(gateway, cid, path = "") {
  const normalizedPath = normalizeIpfsPath(path);
  const encodedPath = normalizedPath
    ? `/${normalizedPath.split("/").map(encodeURIComponent).join("/")}`
    : "";
  return `${gateway.baseUrl}${cid}${encodedPath}`;
}

async function readSample(body) {
  if (!body) {
    return 0;
  }

  const reader = body.getReader();
  let bytes = 0;

  try {
    while (bytes < SAMPLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += Math.min(value.byteLength, SAMPLE_BYTES - bytes);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return bytes;
}

async function probeGateway(gateway, cid, path, fetcher) {
  const url = buildGatewayUrl(gateway, cid, path);
  const startedAt = Date.now();

  try {
    const response = await fetcher(url, {
      headers: {
        Accept: "application/octet-stream",
        Range: `bytes=0-${SAMPLE_BYTES - 1}`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Math.max(Date.now() - startedAt, 1);

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }

    const sampleBytes = await readSample(response.body);
    const durationMs = Math.max(Date.now() - startedAt, 1);
    const kibPerSecond = Math.round(((sampleBytes / 1024) / (durationMs / 1000)) * 10) / 10;

    return {
      id: gateway.id,
      label: gateway.label,
      url,
      ok: true,
      latencyMs,
      sampleBytes,
      kibPerSecond,
    };
  } catch {
    return {
      id: gateway.id,
      label: gateway.label,
      url,
      ok: false,
      latencyMs: null,
      sampleBytes: 0,
      kibPerSecond: 0,
    };
  }
}

export async function probeIpfsGateways(cid, path = "", fetcher = fetch) {
  if (!isValidCid(cid)) {
    throw new TypeError("Invalid CID");
  }
  const normalizedPath = normalizeIpfsPath(path);

  const results = await Promise.all(
    GATEWAYS.map((gateway) => probeGateway(gateway, cid, normalizedPath, fetcher)),
  );

  return results.sort((left, right) => {
    if (left.ok !== right.ok) {
      return left.ok ? -1 : 1;
    }
    if (left.kibPerSecond !== right.kibPerSecond) {
      return right.kibPerSecond - left.kibPerSecond;
    }
    return (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity);
  });
}

function safeFilename(value, cid) {
  const sanitized = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return sanitized || cid;
}

function gatewayOrder(preferredGatewayId) {
  const preferred = GATEWAYS.find((gateway) => gateway.id === preferredGatewayId);
  return preferred
    ? [preferred, ...GATEWAYS.filter((gateway) => gateway.id !== preferredGatewayId)]
    : GATEWAYS;
}

export async function proxyIpfsDownload(
  request,
  { cid, path = "", filename = "", gatewayId = "" },
  fetcher = fetch,
) {
  if (!isValidCid(cid)) {
    throw new TypeError("Invalid CID");
  }

  const normalizedPath = normalizeIpfsPath(path);
  const requestHeaders = new Headers({ Accept: "application/octet-stream, */*;q=0.8" });
  for (const name of DOWNLOAD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      requestHeaders.set(name, value);
    }
  }

  for (const gateway of gatewayOrder(gatewayId)) {
    const url = buildGatewayUrl(gateway, cid, normalizedPath);
    let response;
    try {
      response = await fetcher(url, {
        headers: requestHeaders,
        method: request.method,
        redirect: "follow",
      });
    } catch {
      continue;
    }

    if (!response.ok && response.status !== 304) {
      await response.body?.cancel().catch(() => {});
      continue;
    }

    const headers = new Headers({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `attachment; filename="${safeFilename(filename, cid)}"`,
      "X-Content-Type-Options": "nosniff",
      "X-IPFS-Gateway": gateway.label,
    });
    for (const name of DOWNLOAD_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/octet-stream");
    }

    return new Response(request.method === "HEAD" ? null : response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  return new Response("All IPFS gateways failed", {
    status: 502,
    headers: { "Cache-Control": "no-store" },
  });
}
