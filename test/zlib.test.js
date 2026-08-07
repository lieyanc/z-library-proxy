import assert from "node:assert/strict";
import test from "node:test";

import { parseZlibBook, parseZlibSearch, proxyCoverUrl } from "../src/zlib.js";

// Trimmed copies of the real z-lib.sk markup (2026-08).
const SEARCH_HTML = `
<div id="searchResultBox">
  <div class="book-item resItemBoxBooks ">
    <div class="counter">1</div>
    <z-bookcard id="5833054" isbn="9781940352664" termshash="ed63f513b4ea37e3bd24103f01128333" href="/book/ezXZwvQ35Z/americas-test-kitchen-what-good-cooks-know.html" download="/dl/ZnwYyVDOmo" deleted="0" publisher="America's Test Kitchen" language="English" year="2016" extension="epub" filesize="430.04 MB" rating="5.0" quality="5.0" class="ready">
      <img data-src="https://covers.z-lib.sk/covers100/collections/genesis/986d8f49f675eddca3b315556af86694ddd3e65a4ee4850f5648a0f7d0a44784.jpg">
      <div slot="title">America’s Test Kitchen - What Good Cooks Know</div>
      <div slot="author">America's Test Kitchen</div>
      <div slot="note"></div>
    </z-bookcard>
  </div>
  <div class="book-item resItemBoxBooks ">
    <div class="counter">2</div>
    <z-bookcard id="999" isbn="" href="/book/abc123/some-book.html" download="" deleted="0" publisher="" language="Chinese" year="2020" extension="pdf" filesize="1.20 MB" rating="" class="ready">
      <div slot="title">某本书 &amp; 其他</div>
      <div slot="author">作者甲</div>
    </z-bookcard>
  </div>
</div>`;

const BOOK_HTML = `
<div class="details-book cardBooks">
  <div class="details-book-cover-container">
    <z-cover id="5833054" isbn="9781940352664" class="ready"><img data-src="https://covers.z-library.sk/covers200/collections/userbooks/26bfd93d47edb46cbfd736adf061872c0310cd75ac72299ee3b744bcab25dec7.jpg"></z-cover>
  </div>
  <div class="details-book-info-container">
    <h1 class="book-title" itemprop="name">America’s Test Kitchen - What Good Cooks Know</h1>
    <i class="authors"><a class="color1" href="/author/America%27s Test Kitchen">America's Test Kitchen</a></i>
    <div class="book-actions-container">
      <a class="btn btn-default dlButton addDownloadedBook" href="/dl/ZnwYyVDOmo" data-book_id="5833054" rel="nofollow">
        <i class="zlibicon-bookcard-download"></i><span class="book-property__extension">epub</span>, 430.04 MB
      </a>
    </div>
  </div>
</div>
<div class="bookDetailsBox">
  <div class="bookProperty property_year">
    <div class="property_label">Year:</div>
    <div class="property_value">2016</div>
  </div>
  <div class="bookProperty property_language">
    <div class="property_label">Language:</div>
    <span class="property_value text-capitalize">English</span>
  </div>
  <div class="bookProperty property_ipfs_cid">
    <div class="property_label">IPFS:</div>
    <div class="property_value"><span class="z-copy-icon" data-copy="QmT2Vp9S4bsRqcBRcoAe8Zcpb6tihfj89Ut55NtCcHFf8A">CID</span> , <span class="z-copy-icon" data-copy="bafykbzacecqi7keyyaaqujuz6652w6mr7fxibtkocporp5rvpsizgzlrn3qvm">CID Blake2b</span></div>
  </div>
</div>`;

test("parses z-bookcard entries from a search page", () => {
  const books = parseZlibSearch(SEARCH_HTML);

  assert.equal(books.length, 2);
  const first = books[0];
  assert.equal(first.id, "zlib:5833054");
  assert.equal(first.source, "zlib");
  assert.equal(first.title, "America’s Test Kitchen - What Good Cooks Know");
  assert.deepEqual(first.authors, ["America's Test Kitchen"]);
  assert.equal(first.year, 2016);
  assert.deepEqual(first.languages, ["English"]);
  assert.equal(first.extension, "epub");
  assert.equal(first.filesize, "430.04 MB");
  assert.equal(first.rating, "5.0");
  assert.equal(first.publisher, "America's Test Kitchen");
  assert.equal(first.isbn, "9781940352664");
  assert.equal(first.bookPath, "/book/ezXZwvQ35Z/americas-test-kitchen-what-good-cooks-know.html");
  assert.equal(first.downloadPath, "/dl/ZnwYyVDOmo");
  assert.match(first.cover, /^\/__z\/cover\?u=/);

  const second = books[1];
  assert.equal(second.title, "某本书 & 其他");
  assert.equal(second.year, 2020);
  assert.equal(second.cover, null);
  assert.equal(second.downloadPath, null);
});

test("only proxies covers from the allowlisted hosts", () => {
  const proxied = proxyCoverUrl("https://covers.z-lib.sk/covers100/x.jpg");
  assert.match(proxied, /^\/__z\/cover\?u=/);

  assert.equal(proxyCoverUrl("https://evil.example.com/x.jpg"), null);
  assert.equal(proxyCoverUrl("http://covers.z-lib.sk/x.jpg"), null);
  assert.equal(proxyCoverUrl("not a url"), null);
});

test("parses a book detail page", () => {
  const book = parseZlibBook(BOOK_HTML, "/book/ezXZwvQ35Z/americas-test-kitchen-what-good-cooks-know.html");

  assert.equal(book.title, "America’s Test Kitchen - What Good Cooks Know");
  assert.deepEqual(book.authors, ["America's Test Kitchen"]);
  assert.equal(book.year, 2016);
  assert.deepEqual(book.languages, ["English"]);
  assert.match(book.cover, /^\/__z\/cover\?u=/);
  assert.equal(book.downloadPath, "/dl/ZnwYyVDOmo");
  assert.equal(book.downloadLabel, "epub, 430.04 MB");
  assert.deepEqual(book.ipfsCids, [
    "QmT2Vp9S4bsRqcBRcoAe8Zcpb6tihfj89Ut55NtCcHFf8A",
    "bafykbzacecqi7keyyaaqujuz6652w6mr7fxibtkocporp5rvpsizgzlrn3qvm",
  ]);
  const propertyKeys = book.properties.map((property) => property.key);
  assert.ok(propertyKeys.includes("year"));
  assert.ok(propertyKeys.includes("language"));
  assert.ok(!propertyKeys.includes("ipfs_cid"));
});

test("returns null for a page without a book title", () => {
  assert.equal(parseZlibBook("<html><body>not found</body></html>", "/book/x/y.html"), null);
});
