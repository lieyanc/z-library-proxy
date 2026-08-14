import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import {
  configuredOrigins,
  probeOrigin,
  scanOrigins,
} from "../src/origin-health.js";

function memoryKv() {
  const values = new Map();
  return {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

test("parses and validates the configured origin list", () => {
  assert.deepEqual(
    configuredOrigins({
      UPSTREAM_ORIGINS: "https://z-lib.fm, https://z-lib.gd\nhttps://z-lib.fm",
      UPSTREAM_ORIGIN: "https://fallback.example.com",
    }),
    ["https://z-lib.fm", "https://z-lib.gd", "https://fallback.example.com"],
  );
  assert.deepEqual(configuredOrigins({ UPSTREAM_ORIGINS: "http://insecure.example.com/path" }), []);
});

test("classifies an upstream challenge as reachable but not searchable", async () => {
  const result = await probeOrigin("https://z-lib.fm", async () =>
    new Response("<title>Checking your browser</title><script>c_token=1</script>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    }),
  );

  assert.equal(result.reachable, true);
  assert.equal(result.ok, false);
  assert.equal(result.challenge, true);
  assert.equal(result.status, 503);
});

test("scans configured origins in parallel and records a timestamp", async () => {
  const payload = await scanOrigins(
    { UPSTREAM_ORIGINS: "https://one.example.com https://two.example.com" },
    async (url) => new Response(`<html><z-bookcard data-origin="${url}"></z-bookcard></html>`, { status: 200 }),
  );

  assert.match(payload.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(payload.origins, ["https://one.example.com", "https://two.example.com"]);
  assert.equal(payload.results.length, 2);
  assert.equal(payload.results.every((result) => result.ok), true);
});

test("origin health API reads KV and manual scans write the latest result", async (context) => {
  const originalFetch = globalThis.fetch;
  const kv = memoryKv();
  globalThis.fetch = async () => new Response("<html><z-bookcard></z-bookcard></html>", { status: 200 });
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    ORIGIN_HEALTH: kv,
    UPSTREAM_ORIGINS: "https://z-lib.fm",
  };
  const before = await worker.fetch(new Request("https://books.example.com/__z/api/origins"), env);
  assert.deepEqual(await before.json(), {
    checkedAt: null,
    origins: ["https://z-lib.fm"],
    results: [],
    persisted: true,
  });

  const scan = await worker.fetch(
    new Request("https://books.example.com/__z/api/origins/scan", { method: "POST" }),
    env,
  );
  assert.equal(scan.status, 200);
  const scanned = await scan.json();
  assert.equal(scanned.results[0].ok, true);
  assert.equal(scanned.persisted, true);

  const after = await worker.fetch(new Request("https://books.example.com/__z/api/origins"), env);
  assert.deepEqual(await after.json(), scanned);
});

test("scheduled scans persist the latest origin health payload", async () => {
  const originalFetch = globalThis.fetch;
  const kv = memoryKv();
  globalThis.fetch = async () => new Response("<html><z-bookcard></z-bookcard></html>", { status: 200 });
  try {
    const pending = [];
    worker.scheduled({}, { ORIGIN_HEALTH: kv, UPSTREAM_ORIGINS: "https://z-lib.fm" }, {
      waitUntil(promise) {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
    const stored = await kv.get("latest", "json");
    assert.equal(stored.results[0].ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
