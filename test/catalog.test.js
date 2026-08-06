import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGutenbergBooks,
  normalizeOpenLibraryBooks,
  searchOpenCatalogs,
} from "../src/catalog.js";

test("keeps only public-domain Gutenberg books and safe HTTPS formats", () => {
  const books = normalizeGutenbergBooks({
    results: [
      {
        id: 11,
        title: "Alice's Adventures in Wonderland",
        copyright: false,
        authors: [{ name: "Carroll, Lewis" }],
        languages: ["en"],
        formats: {
          "application/epub+zip": "https://www.gutenberg.org/ebooks/11.epub3.images",
          "text/html": "http://www.gutenberg.org/ebooks/11.html",
          "image/jpeg": "https://www.gutenberg.org/cache/epub/11/pg11.cover.medium.jpg",
        },
      },
      {
        id: 99,
        title: "Copyrighted",
        copyright: true,
        formats: {},
      },
    ],
  });

  assert.equal(books.length, 1);
  assert.equal(books[0].rightsLabel, "公版");
  assert.deepEqual(books[0].downloads, [
    {
      label: "EPUB",
      href: "https://www.gutenberg.org/ebooks/11.epub3.images",
    },
  ]);
});

test("keeps only public Open Library scans", () => {
  const books = normalizeOpenLibraryBooks({
    docs: [
      {
        key: "/works/OL138052W",
        title: "Alice's Adventures in Wonderland",
        ebook_access: "public",
        public_scan_b: true,
        author_name: ["Lewis Carroll"],
        cover_i: 10527843,
      },
      {
        key: "/works/OL273644W",
        title: "The Color Purple",
        ebook_access: "borrowable",
        public_scan_b: false,
      },
    ],
  });

  assert.equal(books.length, 1);
  assert.equal(books[0].details, "https://openlibrary.org/works/OL138052W");
  assert.equal(books[0].rightsLabel, "公开阅读");
});

test("returns partial catalog results when one provider fails", async () => {
  const fetcher = async (url) => {
    if (new URL(url).hostname === "gutendex.com") {
      throw new Error("unavailable");
    }

    return Response.json({
      docs: [
        {
          key: "/works/OL1W",
          title: "Public book",
          ebook_access: "public",
          public_scan_b: true,
        },
      ],
    });
  };

  const result = await searchOpenCatalogs("public book", fetcher);

  assert.equal(result.results.length, 1);
  assert.equal(result.sources.gutenberg.ok, false);
  assert.equal(result.sources.openlibrary.ok, true);
});
