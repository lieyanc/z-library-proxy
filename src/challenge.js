// Solver for the upstream SHA-1 proof-of-work anti-bot challenge plus a
// resilient upstream fetch wrapper (challenge solving + transient 5xx retry).
//
// Challenge format (served as a 503 "Checking your browser" HTML page):
//   salt    — 40 hex chars embedded in the page script
//   index   — parseInt("0x" + salt[0])
//   goal    — first i such that sha1(salt + i) has byte[index] === byteA
//             and byte[index + 1] === byteB
//   cookies — c_token = salt + i, c_time = seconds spent solving

const CHALLENGE_TITLE = "Checking your browser";
const CHALLENGE_MARKER = "c_token=";
const DEFAULT_BYTE_A = 0xb0;
const DEFAULT_BYTE_B = 0x0b;
const MAX_SOLVE_ITERATIONS = 1_200_000;
const SESSION_TTL_MS = 30 * 60 * 1000;
// 429 is included because upstream rate-limits the shared Cloudflare egress
// IPs (the worker has no IP of its own): a later attempt frequently lands on
// a healthier egress and succeeds, so failing instantly would be wrong.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_SOLVES_PER_REQUEST = 2;
// Longer backoffs give the upstream rate-limit window (429) more time to
// cool down and let later attempts sample different egress IPs.
const RETRY_BACKOFF_MS = [500, 1500, 4000];
// Longest a single attempt may run when the caller set a total budget
// (timeoutMs): a hung upstream must not consume the whole budget before the
// retry loop gets a chance to try another egress.
const ATTEMPT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// SHA-1 proof-of-work solving.
//
// Uses WebCrypto instead of pure JS: time spent inside crypto.subtle.digest
// does not count against the Workers CPU limit, so a solve costs mostly
// wall-clock time. Solving happens once per session per isolate and falls
// back to letting the visitor's browser solve the challenge when it fails.
// ---------------------------------------------------------------------------

const SOLVE_BATCH_SIZE = 256;
const SOLVE_WALL_CLOCK_BUDGET_MS = 8000;

function writeCandidate(block, saltBytes, i) {
  block.set(saltBytes);
  let value = i;
  let digits = 1;
  while (value >= 10) {
    value = Math.floor(value / 10);
    digits += 1;
  }
  value = i;
  for (let p = digits - 1; p >= 0; p -= 1) {
    block[saltBytes.length + p] = 0x30 + (value % 10);
    value = Math.floor(value / 10);
  }
  return saltBytes.length + digits;
}

export async function solveChallenge({ salt, index, byteA, byteB }) {
  const saltBytes = new TextEncoder().encode(salt);
  const template = new Uint8Array(64);
  const startedAt = performance.now();

  for (let base = 0; base < MAX_SOLVE_ITERATIONS; base += SOLVE_BATCH_SIZE) {
    const jobs = [];
    const batchEnd = Math.min(base + SOLVE_BATCH_SIZE, MAX_SOLVE_ITERATIONS);
    for (let i = base; i < batchEnd; i += 1) {
      const length = writeCandidate(template, saltBytes, i);
      jobs.push(crypto.subtle.digest("SHA-1", template.subarray(0, length)));
    }

    let digests;
    try {
      digests = await Promise.all(jobs);
    } catch {
      return null;
    }

    for (let k = 0; k < digests.length; k += 1) {
      const bytes = new Uint8Array(digests[k]);
      if (bytes[index] === byteA && bytes[index + 1] === byteB) {
        return {
          token: `${salt}${base + k}`,
          seconds: (performance.now() - startedAt) / 1000,
        };
      }
    }

    if (performance.now() - startedAt > SOLVE_WALL_CLOCK_BUDGET_MS) {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Challenge parsing + solving
// ---------------------------------------------------------------------------

export function parseChallenge(html) {
  if (typeof html !== "string" || !html.includes(CHALLENGE_MARKER)) {
    return null;
  }

  const saltMatch = html.match(/'([0-9A-Fa-f]{40})'/);
  if (!saltMatch) {
    return null;
  }
  const salt = saltMatch[1].toUpperCase();

  let byteA = DEFAULT_BYTE_A;
  let byteB = DEFAULT_BYTE_B;
  const conditionA = html.match(/\[\s*n1\s*\]\s*===\s*0x([0-9a-fA-F]{1,2})/);
  const conditionB = html.match(/\[\s*n1\s*\+\s*0x?0*1\s*\]\s*===\s*0x([0-9a-fA-F]{1,2})/);
  if (conditionA) {
    byteA = Number.parseInt(conditionA[1], 16);
  }
  if (conditionB) {
    byteB = Number.parseInt(conditionB[1], 16);
  }

  return {
    salt,
    index: Number.parseInt(salt[0], 16),
    byteA,
    byteB,
  };
}

// ---------------------------------------------------------------------------
// Session jar + resilient upstream fetching
// ---------------------------------------------------------------------------

const sessions = new Map();
const solveLocks = new Map();

function readSession(origin) {
  const session = sessions.get(origin);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(origin);
    return null;
  }
  return session;
}

export function storeSessionCookies(origin, cookies) {
  if (!cookies || Object.keys(cookies).length === 0) {
    return;
  }
  const session = sessions.get(origin) || { cookies: {}, expiresAt: 0 };
  Object.assign(session.cookies, cookies);
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(origin, session);
}

// Exported for tests.
export function getSessionCookies(origin) {
  return readSession(origin)?.cookies || null;
}

export function parseSetCookiePairs(setCookies) {
  const cookies = {};
  for (const header of setCookies || []) {
    const pair = String(header).split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0) {
      cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return cookies;
}

function mergeCookieHeader(existingHeader, sessionCookies) {
  const names = new Set(
    (existingHeader || "")
      .split(";")
      .map((part) => part.split("=", 1)[0].trim())
      .filter(Boolean),
  );
  const additions = Object.entries(sessionCookies)
    .filter(([name]) => !names.has(name))
    .map(([name, value]) => `${name}=${value}`);
  const merged = [existingHeader, ...additions].filter(Boolean).join("; ");
  return merged || null;
}

async function solveAndStore(origin, html) {
  const challenge = parseChallenge(html);
  if (!challenge) {
    return false;
  }
  const solution = await solveChallenge(challenge);
  if (!solution) {
    return false;
  }
  storeSessionCookies(origin, {
    c_token: solution.token,
    c_time: solution.seconds.toFixed(3),
  });
  return true;
}

async function solveWithLock(origin, html) {
  const pending = solveLocks.get(origin);
  if (pending) {
    return pending;
  }
  const task = solveAndStore(origin, html).finally(() => {
    solveLocks.delete(origin);
  });
  solveLocks.set(origin, task);
  return task;
}

function responseWithText(text, response) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.set("Content-Length", String(new TextEncoder().encode(text).length));
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Thrown in delegate mode: the caller (browser frontend) should solve the
// challenge locally and POST the token to /__z/api/challenge. Carries the
// cookies the 503 response set (bsrv stickiness) so they can ride along with
// the challenge payload: upstream only accepts a c_token paired with the bsrv
// issued by the same 503 response.
export class ChallengeRequiredError extends Error {
  constructor(challenge, cookies = {}) {
    super("Upstream challenge must be solved by the client");
    this.name = "ChallengeRequiredError";
    this.challenge = challenge;
    this.cookies = cookies;
  }
}

export function looksLikeChallenge(response) {
  if (response.status !== 503) {
    return false;
  }
  const contentType = response.headers.get("Content-Type") || "";
  return contentType.toLowerCase().includes("text/html");
}

// Fetches an upstream URL, transparently solving the PoW challenge and
// retrying transient 5xx failures. Returns the final upstream response.
// With delegateChallenge: true the challenge is not solved here; a
// ChallengeRequiredError carrying the parsed challenge (plus the cookies the
// 503 set) is thrown instead so the caller can hand it to the visitor's
// browser. In delegate mode nothing is written to the isolate-local session
// jar: the bsrv stickiness cookie is only valid paired with the token solved
// for the same 503 response, so the session lives on the client (the worker
// is stateless and requests may land on different isolates).
// `sessionCookies` (a plain cookie object) overrides the jar for this fetch.
// `timeoutMs` bounds the whole retry sequence; each attempt additionally
// gets its own shorter signal so a hung upstream (tarpit) aborts just that
// attempt and the next attempt still gets a fresh slice of the budget.
export async function fetchUpstream(
  url,
  init,
  { origin, fetchImpl = fetch, delegateChallenge = false, sessionCookies = null, timeoutMs = null } = {},
) {
  const sessionOrigin = origin || new URL(url).origin;
  let solves = 0;
  const startedAt = Date.now();
  const totalSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const headers = new Headers(init?.headers);
    const cookies = sessionCookies || readSession(sessionOrigin)?.cookies || null;
    if (cookies) {
      const merged = mergeCookieHeader(headers.get("Cookie"), cookies);
      if (merged) {
        headers.set("Cookie", merged);
      }
    }

    let signal = init?.signal ?? undefined;
    if (totalSignal) {
      if (totalSignal.aborted) {
        // The budget ran out while waiting between attempts.
        throw totalSignal.reason ?? new Error("fetchUpstream timed out");
      }
      const remaining = Math.max(timeoutMs - (Date.now() - startedAt), 1);
      // An attempt may use at most 60% of the remaining budget (hard-capped),
      // so a hung upstream can never consume the whole budget before the
      // retry loop gets another chance.
      const attemptBudget = Math.min(remaining, ATTEMPT_TIMEOUT_MS, Math.max(Math.ceil(remaining * 0.6), 1));
      signal = AbortSignal.any([totalSignal, AbortSignal.timeout(attemptBudget)]);
    }

    let response;
    try {
      response = await fetchImpl(url, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (error) {
      // Network failures and per-attempt timeouts: retry while attempts and
      // budget remain — a later attempt may land on a healthier upstream IP.
      if (attempt + 1 < MAX_ATTEMPTS && (!totalSignal || !totalSignal.aborted)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 2000));
        continue;
      }
      throw error;
    }

    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : typeof response.headers.getAll === "function"
          ? response.headers.getAll("Set-Cookie")
          : [];
    const freshCookies = parseSetCookiePairs(setCookies);
    if (!delegateChallenge && !sessionCookies && Object.keys(freshCookies).length > 0) {
      storeSessionCookies(sessionOrigin, freshCookies);
    }

    if (!RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }

    // Buffer small error pages so we can inspect (challenge) and, if needed,
    // return them unchanged without leaving a consumed body behind.
    const text = await response.text();

    if (response.status === 503 && text.includes(CHALLENGE_TITLE)) {
      if (delegateChallenge) {
        const challenge = parseChallenge(text);
        if (challenge) {
          throw new ChallengeRequiredError(challenge, freshCookies);
        }
      } else if (solves < MAX_SOLVES_PER_REQUEST && attempt + 1 < MAX_ATTEMPTS) {
        solves += 1;
        const solved = await solveWithLock(sessionOrigin, text);
        if (solved) {
          continue;
        }
      }
    }

    if (attempt + 1 < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 800));
      continue;
    }

    return responseWithText(text, response);
  }

  throw new Error("fetchUpstream exhausted attempts");
}
