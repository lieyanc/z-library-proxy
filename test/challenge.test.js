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

test("delegate mode surfaces the challenge and keeps the bsrv cookie", async () => {
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
      return true;
    },
  );
  assert.equal(getSessionCookies(origin).bsrv, "delegatebsrv");
});

test("stores browser-solved challenge tokens via the API", async () => {
  const response = await worker.fetch(
    new Request("https://books.example.com/__z/api/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "5DF2217304C9448892E026858C3CB92E301A725E6494",
        seconds: 1.234,
      }),
    }),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(
    getSessionCookies("https://z-lib.sk").c_token,
    "5DF2217304C9448892E026858C3CB92E301A725E6494",
  );
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

  const badMethod = await worker.fetch(
    new Request("https://books.example.com/__z/api/challenge"),
    { UPSTREAM_ORIGIN: "https://z-lib.sk" },
  );
  assert.equal(badMethod.status, 405);
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
