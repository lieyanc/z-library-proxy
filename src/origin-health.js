export const ORIGIN_HEALTH_KEY = "latest";

const PROBE_PATH = "/s/1984";
const PROBE_TIMEOUT_MS = 8000;
const MAX_ORIGINS = 32;

const PROBE_HEADERS = {
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
};

function normalizeOrigin(value) {
  try {
    const origin = new URL(String(value).trim());
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

// UPSTREAM_ORIGINS accepts comma, whitespace, or newline-separated origins.
// The singular UPSTREAM_ORIGIN remains a fallback for existing deployments.
export function configuredOrigins(env = {}) {
  const configured = String(env.UPSTREAM_ORIGINS || "")
    .split(/[\s,]+/)
    .map(normalizeOrigin)
    .filter(Boolean);
  const fallback = normalizeOrigin(env.UPSTREAM_ORIGIN || "");
  return [...new Set([...configured, ...(fallback ? [fallback] : [])])].slice(0, MAX_ORIGINS);
}

function isChallengePage(body) {
  return /checking your browser|c_token=|__ab\/verify/i.test(body);
}

function looksLikeZlibPage(body) {
  return /z-bookcard|searchResultBox|z-library|z-lib/i.test(body);
}

export async function probeOrigin(origin, fetchImpl = fetch) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${origin}${PROBE_PATH}`, {
      headers: PROBE_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.text();
    const challenge = isChallengePage(body);
    const sourcePage = looksLikeZlibPage(body);

    return {
      origin,
      host: new URL(origin).host,
      reachable: true,
      ok: response.ok && !challenge && sourcePage,
      challenge,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      error: response.ok && !challenge && !sourcePage ? "Unexpected response" : null,
    };
  } catch (error) {
    return {
      origin,
      host: new URL(origin).host,
      reachable: false,
      ok: false,
      challenge: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export async function scanOrigins(env = {}, fetchImpl = fetch) {
  const origins = configuredOrigins(env);
  const results = await Promise.all(origins.map((origin) => probeOrigin(origin, fetchImpl)));
  return {
    checkedAt: new Date().toISOString(),
    origins,
    results,
  };
}

export async function readOriginHealth(kv) {
  if (!kv || typeof kv.get !== "function") {
    return null;
  }
  try {
    const value = await kv.get(ORIGIN_HEALTH_KEY, "json");
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    console.error("Origin health KV read failed", error);
    return null;
  }
}

export async function writeOriginHealth(kv, payload) {
  if (!kv || typeof kv.put !== "function") {
    return false;
  }
  await kv.put(ORIGIN_HEALTH_KEY, JSON.stringify(payload));
  return true;
}
