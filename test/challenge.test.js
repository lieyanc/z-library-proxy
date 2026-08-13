import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker from "../src/index.js";
import {
  ChallengeRequiredError,
  fetchUpstream,
  getSessionCookies,
  parseChallenge,
  parseSetCookiePairs,
  solveChallenge,
} from "../src/challenge.js";

// Trimmed copy of the real 503 challenge page served by z-lib.sk (2026-08),
// with the salt observed in a live browser session.
const CHALLENGE_HTML = `<!DOCTYPE html><html><head><title>Checking your browser ...</title></head><body><script>window.onload=async function(){const a0_0x2a54=['5DF2217304C9448892E026858C3CB92E301A725E','c_token=','array'];let c='5DF2217304C9448892E026858C3CB92E301A725E';let n1=parseInt('0x'+c[0x0]);while(!![]){let s=s1.array(c+i);if((s[n1]===0xb0)&&(s[n1+0x1]===0xb)){document['cookie']='c_token='+c+i+'; path=/';window.location.reload();break;}i++;}}</script></body></html>`;

test("parses the salt, index, and condition bytes from a challenge page", () => {
  const challenge = parseChallenge(CHALLENGE_HTML);

  assert.deepEqual(challenge, {
    salt: "5DF2217304C9448892E026858C3CB92E301A725E",
    index: 5,
    byteA: 0xb0,
    byteB: 0x0b,
  });
});

test("rejects pages that are not challenges", () => {
  assert.equal(parseChallenge("<html><body>hello</body></html>"), null);
  assert.equal(parseChallenge(""), null);
});

test("solves the challenge and matches the token a real browser produced", async () => {
  const challenge = parseChallenge(CHALLENGE_HTML);
  const solution = await solveChallenge(challenge);

  // A real browser session stored c_token=5DF2217304C9448892E026858C3CB92E301A725E6494.
  assert.equal(solution.token, "5DF2217304C9448892E026858C3CB92E301A725E6494");
  assert.ok(solution.seconds >= 0);

  const digest = createHash("sha1").update(solution.token).digest();
  assert.equal(digest[challenge.index], challenge.byteA);
  assert.equal(digest[challenge.index + 1], challenge.byteB);
});

test("parses Set-Cookie pairs", () => {
  assert.deepEqual(
    parseSetCookiePairs([
      "bsrv=abc123; path=/",
      "session=xyz; Domain=.z-lib.sk; HttpOnly",
    ]),
    { bsrv: "abc123", session: "xyz" },
  );
});

test("solves the challenge once, then replays the request with session cookies", async () => {
  const origin = "https://challenge.test";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers.get("Cookie") });
    if (calls.length === 1) {
      return new Response(CHALLENGE_HTML, {
        status: 503,
        headers: {
          "Content-Type": "text/html;charset=utf-8",
          "Set-Cookie": "bsrv=firstbsrv; path=/",
        },
      });
    }
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const response = await fetchUpstream(`${origin}/s/test`, {}, { fetchImpl });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].cookie, /bsrv=firstbsrv/);
  assert.match(calls[1].cookie, /c_token=5DF2217304C9448892E026858C3CB92E301A725E6494/);
  assert.match(calls[1].cookie, /c_time=\d+\.\d{3}/);
  assert.equal(getSessionCookies(origin).bsrv, "firstbsrv");

  // A later request reuses the jar without re-solving.
  const again = await fetchUpstream(`${origin}/s/other`, {}, { fetchImpl });
  assert.equal(again.status, 200);
  assert.equal(calls.length, 3);
  assert.match(calls[2].cookie, /c_token=/);
});

test("retries transient 502 responses before giving up", async () => {
  const origin = "https://flaky.test";
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const response = await fetchUpstream(`${origin}/`, {}, { fetchImpl });

  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
});

test("retries transient 429 rate-limit responses before giving up", async () => {
  const origin = "https://ratelimited.test";
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response("too many requests", {
        status: 429,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const response = await fetchUpstream(`${origin}/s/test`, {}, { fetchImpl });

  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
});

test("a hung attempt times out alone and the next attempt still runs", async () => {
  const origin = "https://slow.test";
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      // First attempt hangs until its per-attempt signal fires.
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
        );
      });
    }
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const startedAt = Date.now();
  const response = await fetchUpstream(`${origin}/s/test`, {}, { fetchImpl, timeoutMs: 1500 });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt < 4000);
});

test("the total timeout budget still bounds the whole retry sequence", async () => {
  const origin = "https://alwaysslow.test";
  const fetchImpl = async (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      );
    });

  const startedAt = Date.now();
  await assert.rejects(
    fetchUpstream(`${origin}/s/test`, {}, { fetchImpl, timeoutMs: 1200 }),
    (error) => error?.name === "TimeoutError",
  );
  assert.ok(Date.now() - startedAt < 4000);
});

test("returns the upstream error page untouched after retries are exhausted", async () => {
  const fetchImpl = async () =>
    new Response("<html>still broken</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });

  const response = await fetchUpstream("https://down.test/", {}, { fetchImpl });

  assert.equal(response.status, 502);
  assert.equal(await response.text(), "<html>still broken</html>");
});

test("delegate mode surfaces the challenge with its bsrv cookie, without touching the jar", async () => {
  const origin = "https://delegate.test";
  const fetchImpl = async () =>
    new Response(CHALLENGE_HTML, {
      status: 503,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Set-Cookie": "bsrv=delegatebsrv; path=/",
      },
    });

  await assert.rejects(
    fetchUpstream(`${origin}/s/test`, {}, { fetchImpl, delegateChallenge: true }),
    (error) => {
      assert.ok(error instanceof ChallengeRequiredError);
      assert.equal(error.challenge.salt, "5DF2217304C9448892E026858C3CB92E301A725E");
      assert.equal(error.challenge.index, 5);
      assert.equal(error.cookies.bsrv, "delegatebsrv");
      return true;
    },
  );
  // Delegate mode keeps the session on the client; the jar stays empty.
  assert.equal(getSessionCookies(origin), null);
});

test("explicit session cookies override the isolate-local jar", async () => {
  const origin = "https://override.test";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers.get("Cookie") });
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "Content-Type": "text/html", "Set-Cookie": "bsrv=fresh; path=/" },
    });
  };

  const response = await fetchUpstream(
    `${origin}/s/test`,
    {},
    { fetchImpl, sessionCookies: { bsrv: "clientbsrv", c_token: "C".repeat(40) + "1" } },
  );

  assert.equal(response.status, 200);
  assert.match(calls[0].cookie, /bsrv=clientbsrv/);
  // Client-held sessions are not merged into the isolate-local jar either.
  assert.equal(getSessionCookies(origin), null);
});

test("challenge submissions set a client-held session cookie", async () => {
  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "5DF2217304C9448892E026858C3CB92E301A725E6494",
        seconds: 1.234,
        bsrv: "63deec3e1b9160645ba500d2462bd144",
      }),
    }),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const setCookie = response.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /^z_zlib_session=[A-Za-z0-9_-]+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  const encoded = setCookie.match(/^z_zlib_session=([^;]*)/)[1];
  const session = JSON.parse(Buffer.from(encoded, "base64url").toString());
  assert.deepEqual(session, {
    c_token: "5DF2217304C9448892E026858C3CB92E301A725E6494",
    c_time: "1.234",
    bsrv: "63deec3e1b9160645ba500d2462bd144",
  });

  // The submission no longer writes to the isolate-local jar.
  assert.equal(getSessionCookies("https://z-lib.sk"), null);
});

test("rejects malformed challenge submissions", async () => {
  const badToken = await worker.fetch(
    new Request("https://books.example.com/__z/api/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-token", seconds: 1 }),
    }),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  assert.equal(badToken.status, 400);

  const badBsrv = await worker.fetch(
    new Request("https://books.example.com/__z/api/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "5DF2217304C9448892E026858C3CB92E301A725E6494",
        seconds: 1,
        bsrv: "not valid!",
      }),
    }),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  assert.equal(badBsrv.status, 400);

  const badMethod = await worker.fetch(
    new Request("https://books.example.com/__z/api/challenge"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  assert.equal(badMethod.status, 405);
});

test("zsearch challenge payload carries the bsrv from the same 503 response", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const rawHeaders = init?.headers;
    const cookie = rawHeaders?.get
      ? rawHeaders.get("Cookie")
      : rawHeaders?.Cookie || rawHeaders?.cookie || null;
    calls.push({ url: String(url), cookie });
    return new Response(CHALLENGE_HTML, {
      status: 503,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Set-Cookie": "bsrv=63deec3e1b9160645ba500d2462bd144; path=/",
      },
    });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/zsearch?q=test"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.challenge.salt, "5DF2217304C9448892E026858C3CB92E301A725E");
  assert.equal(payload.challenge.bsrv, "63deec3e1b9160645ba500d2462bd144");
});

test("zsearch forwards the client-held session cookie upstream", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const rawHeaders = init?.headers;
    const cookie = rawHeaders?.get
      ? rawHeaders.get("Cookie")
      : rawHeaders?.Cookie || rawHeaders?.cookie || null;
    calls.push({ url: String(url), cookie });
    return new Response("<html><body>no cards</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const session = Buffer.from(
    JSON.stringify({
      bsrv: "63deec3e1b9160645ba500d2462bd144",
      c_token: "5DF2217304C9448892E026858C3CB92E301A725E6494",
      c_time: "1.234",
    }),
  ).toString("base64url");

  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/zsearch?q=test", {
      headers: { Cookie: `z_zlib_session=${session}` },
    }),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/z-lib\.sk\/s\/test/);
  assert.match(calls[0].cookie, /bsrv=63deec3e1b9160645ba500d2462bd144/);
  assert.match(calls[0].cookie, /c_token=5DF2217304C9448892E026858C3CB92E301A725E6494/);
});

test("zsearch failure payloads are not cached at the edge", async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("too many requests", {
      status: 429,
      headers: { "Content-Type": "text/html" },
    });
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/zsearch?q=test"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.sources.zlib.ok, false);
  assert.match(payload.sources.zlib.error, /429/);
  assert.equal(payload.sources.zlib.rateLimited, true);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("zsearch recovers when the upstream rate limit clears on a later attempt", async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response("too many requests", {
        status: 429,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(
      '<z-bookcard id="1" href="/book/1/title.html"><div slot="title">A Book</div><div slot="author">An Author</div></z-bookcard>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/zsearch?q=test"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.sources.zlib.ok, true);
  assert.equal(payload.sources.zlib.rateLimited, false);
  assert.equal(payload.results.length, 1);
  assert.equal(calls, 3);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, stale-while-revalidate=900");
});

test("zsearch successes are cached and served without touching upstream again", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const entry = store.get(String(key));
        return entry ? entry.clone() : undefined;
      },
      async put(key, value) {
        store.set(String(key), value.clone());
      },
    },
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      '<z-bookcard id="1" href="/book/1/t.html"><div slot="title">A Book</div></z-bookcard>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  });

  const url = "https://books.example.com/__z/api/zsearch?q=test";
  const first = await worker.fetch(new Request(url), { UPSTREAM_ORIGIN: "https://z-lib.sk" });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).results.length, 1);
  assert.equal(calls, 1);

  const second = await worker.fetch(new Request(url), { UPSTREAM_ORIGIN: "https://z-lib.sk" });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).results.length, 1);
  assert.equal(calls, 1, "the second request must be served from the cache");

  // Failures are not written to the cache: a new failing request must still
  // hit upstream on every call.
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("rate limited", {
      status: 429,
      headers: { "Content-Type": "text/html" },
    });
  };
  const failing = await worker.fetch(
    new Request("https://books.example.com/__z/api/zsearch?q=other"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  assert.equal((await failing.json()).sources.zlib.ok, false);
  assert.ok(calls > 2, "the failing search must not be served from the cache");
});

test("concurrent identical zsearches share one upstream fetch", async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    await gate;
    return new Response(
      '<z-bookcard id="1" href="/book/1/t.html"><div slot="title">A Book</div></z-bookcard>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const url = "https://books.example.com/__z/api/zsearch?q=test";
  const first = worker.fetch(new Request(url), { UPSTREAM_ORIGIN: "https://z-lib.sk" });
  const second = worker.fetch(new Request(url), { UPSTREAM_ORIGIN: "https://z-lib.sk" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(calls, 1);
});

test("account download requires configuration", async () => {
  const response = await worker.fetch(
    new Request("https://books.example.com/__z/dl/AbC123"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk", ZLIB_ACCOUNT_COOKIES: "" },
  );
  assert.equal(response.status, 501);
});

test("account download resolves /dl/ with account cookies and relays the CDN file", async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const rawHeaders = init?.headers;
    const cookie = rawHeaders?.get
      ? rawHeaders.get("Cookie")
      : rawHeaders?.Cookie || rawHeaders?.cookie || null;
    calls.push({ url: String(url), cookie });
    if (String(url).includes("/dl/")) {
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            "https://dln1.ncdn.ec/books-files/x/redirection?filename=My%20Book%20%E4%B8%AD%E6%96%87.epub",
        },
      });
    }
    return new Response("EPUB-BYTES", {
      status: 200,
      headers: {
        "Content-Type": "application/epub+zip",
        "Content-Length": "10",
        "Accept-Ranges": "bytes",
      },
    });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(
    new Request("https://books.example.com/__z/dl/AbC123"),
    {
      UPSTREAM_ORIGIN: "https://z-lib.sk",
      ZLIB_ACCOUNT_COOKIES: "remix_userid=1; remix_userkey=secret",
    },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "EPUB-BYTES");
  assert.equal(response.headers.get("Content-Type"), "application/epub+zip");
  assert.match(
    response.headers.get("Content-Disposition") || "",
    /filename\*=UTF-8''My%20Book%20%E4%B8%AD%E6%96%87.epub/,
  );
  // 账户 cookie 只出现在 /dl/ 解析请求里,CDN 请求不带任何 cookie
  assert.match(calls[0].cookie, /remix_userkey=secret/);
  assert.equal(calls[1].cookie, null);
});
