import assert from "node:assert/strict";
import test from "node:test";

import {
  isCidAllowed,
  isValidCid,
  normalizeIpfsPath,
  probeIpfsGateways,
  proxyIpfsDownload,
} from "../src/ipfs.js";

const CID_V0 = "QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX";
const CID_V1 = "bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq";

test("validates CIDv0 and base32 CIDv1 values", () => {
  assert.equal(isValidCid(CID_V0), true);
  assert.equal(isValidCid(CID_V1), true);
  assert.equal(isValidCid("../../metadata"), false);
  assert.equal(isValidCid("https://example.com"), false);
});

test("authorizes only exact configured CIDs and safe paths", () => {
  assert.equal(isCidAllowed(CID_V0, `${CID_V1}, ${CID_V0}`), true);
  assert.equal(isCidAllowed(CID_V0, CID_V1), false);
  assert.equal(normalizeIpfsPath("books/alice.epub"), "books/alice.epub");
  assert.throws(() => normalizeIpfsPath("../secret"), /Invalid IPFS path/);
});

test("sorts available IPFS gateways by sampled throughput", async () => {
  const fetcher = async (url) => {
    const hostname = new URL(url).hostname;
    if (hostname === "w3s.link") {
      return new Response("unavailable", { status: 503 });
    }

    const bytes = hostname === "dweb.link" ? 64 * 1024 : 1024;
    return new Response(new Uint8Array(bytes), { status: 206 });
  };

  const results = await probeIpfsGateways(CID_V0, "", fetcher);

  assert.equal(results[0].label, "dweb.link");
  assert.equal(results[0].ok, true);
  assert.equal(results[0].kibPerSecond > 0, true);
  assert.equal(results.at(-1).label, "w3s.link");
  assert.equal(results.at(-1).ok, false);
});

test("streams an IPFS download, forwards Range, and falls back between gateways", async () => {
  const attempts = [];
  const fetcher = async (url, init) => {
    attempts.push({ url, init });
    if (new URL(url).hostname === "dweb.link") {
      return new Response("unavailable", { status: 503 });
    }

    return new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 10-12/100",
        "Content-Type": "application/epub+zip",
      },
    });
  };
  const request = new Request("https://books.example.com/__z/ipfs/test", {
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      Range: "bytes=10-12",
    },
  });

  const response = await proxyIpfsDownload(
    request,
    {
      cid: CID_V0,
      filename: "Alice.epub",
      gatewayId: "dweb",
      path: "books/alice.epub",
    },
    fetcher,
  );

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].init.headers.get("Range"), "bytes=10-12");
  assert.equal(attempts[0].init.headers.get("Cookie"), null);
  assert.equal(attempts[0].init.headers.get("Authorization"), null);
  assert.match(attempts[1].url, /ipfs\.io\/ipfs\/.+\/books\/alice\.epub$/);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("X-IPFS-Gateway"), "ipfs.io");
  assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="Alice.epub"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});
