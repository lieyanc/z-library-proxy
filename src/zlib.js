// Parsers that turn z-lib HTML pages into plain data so the frontend can
// render results with its own UI. Markup reference (2026-08):
//   search page  — <z-bookcard id=... href=... download=... language=... ...>
//                  with <div slot="title|author"> and <img data-src="covers…">
//   book page    — h1.book-title, i.authors, .bookDetailsBox .bookProperty,
//                  a.dlButton[href^="/dl/"], property_ipfs_cid data-copy attrs

const CARD_RE = /<z-bookcard\b([^>]*)>([\s\S]*?)<\/z-bookcard>/gi;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const PROPERTY_RE =
  /<div class=["']bookProperty property_([\w-]+)[^"']*["']>[\s\S]*?<div class=["']property_label["']>([\s\S]*?)<\/div>[\s\S]*?<(?:div|span) class=["']property_value[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/gi;

export const COVER_HOSTS = new Set(["covers.z-lib.sk", "covers.z-library.sk"]);

function decodeEntities(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'");
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function parseAttributes(raw) {
  const attrs = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2]);
  }
  return attrs;
}

function slotText(inner, slot) {
  const match = inner.match(new RegExp(`<div slot="${slot}">([\\s\\S]*?)<\\/div>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function firstMatch(html, regex) {
  const match = html.match(regex);
  return match ? match[1] : null;
}

// Rewrites an upstream cover URL to the local image proxy so covers load
// without direct third-party requests. Returns null for unexpected URLs.
export function proxyCoverUrl(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !COVER_HOSTS.has(url.hostname)) {
      return null;
    }
    return `/__z/cover?u=${encodeURIComponent(url.toString())}`;
  } catch {
    return null;
  }
}

export function parseZlibSearch(html) {
  const books = [];

  for (const match of html.matchAll(CARD_RE)) {
    const attrs = parseAttributes(match[1]);
    const inner = match[2];
    const title = slotText(inner, "title");
    const bookPath = attrs.href || "";
    if (!title || !bookPath.startsWith("/book/")) {
      continue;
    }

    const author = slotText(inner, "author");
    const cover = firstMatch(inner, /<img[^>]*(?:data-src|src)="([^"]+)"/i);
    const year = Number.parseInt(attrs.year || "", 10);

    books.push({
      id: `zlib:${attrs.id || bookPath}`,
      source: "zlib",
      sourceLabel: "Z-Library",
      rightsLabel: "授权",
      title,
      authors: author ? [author] : [],
      year: Number.isInteger(year) ? year : null,
      languages: attrs.language ? [attrs.language] : [],
      cover: proxyCoverUrl(cover),
      details: bookPath,
      downloads: [],
      isbn: attrs.isbn || "",
      publisher: attrs.publisher || "",
      extension: attrs.extension || "",
      filesize: attrs.filesize || "",
      rating: attrs.rating || "",
      downloadPath: attrs.download || null,
      bookPath,
    });
  }

  return books;
}

export function parseZlibBook(html, bookPath) {
  const title = stripTags(
    firstMatch(html, /<h1[^>]*class="book-title"[^>]*>([\s\S]*?)<\/h1>/i) || "",
  );
  if (!title) {
    return null;
  }

  const authorsRaw = firstMatch(html, /<i class="authors">([\s\S]*?)<\/i>/i);
  const authors = authorsRaw
    ? authorsRaw
        .match(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)
        ?.map((link) => stripTags(link))
        .filter(Boolean) || [stripTags(authorsRaw)].filter(Boolean)
    : [];

  const cover = firstMatch(html, /<img[^>]*data-src="(https:\/\/covers\.[^"]+)"/i);

  const properties = [];
  const seen = new Set();
  for (const match of html.matchAll(PROPERTY_RE)) {
    const key = match[1].toLowerCase();
    if (key === "ipfs_cid") {
      continue;
    }
    const label = stripTags(match[2]).replace(/:$/, "");
    const value = stripTags(match[3]);
    if (!value || seen.has(label.toLowerCase())) {
      continue;
    }
    seen.add(label.toLowerCase());
    properties.push({ key, label, value });
  }

  const ipfsCids = [
    ...new Set(
      [...html.matchAll(/property_ipfs_cid[\s\S]*?<\/div>\s*<\/div>/gi)]
        .flatMap((block) => [...block[0].matchAll(/data-copy="([^"]+)"/g)])
        .map((m) => m[1]),
    ),
  ];

  const downloadMatch = html.match(
    /<a[^>]*class="[^"]*\bdlButton\b[^"]*"[^>]*href="(\/dl\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
  );
  const downloadPath = downloadMatch ? downloadMatch[1] : null;
  const downloadLabel = downloadMatch ? stripTags(downloadMatch[2]) : "";

  // Numeric book id, used by the /papi/book/<id>/formats endpoint. Present in
  // the inline `new Book({"id":…})` bootstrap and on the download button.
  const bookIdMatch =
    html.match(/new Book\(\{"id":(\d{1,12})/) || html.match(/data-book_id="(\d{1,12})"/);
  const bookId = bookIdMatch ? bookIdMatch[1] : null;

  const description = stripTags(
    firstMatch(html, /<div[^>]*id="bookDescription"[^>]*>([\s\S]*?)<\/div>/i) ||
      firstMatch(html, /<div[^>]*class="book-description"[^>]*>([\s\S]*?)<\/div>/i) ||
      "",
  );

  const yearProp = properties.find((p) => p.key === "year");
  const languageProp = properties.find((p) => p.key === "language");
  const year = Number.parseInt(yearProp?.value || "", 10);

  return {
    id: `zlib:${bookPath}`,
    source: "zlib",
    sourceLabel: "Z-Library",
    rightsLabel: "授权",
    title,
    authors,
    year: Number.isInteger(year) ? year : null,
    languages: languageProp ? [languageProp.value] : [],
    cover: proxyCoverUrl(cover),
    details: bookPath,
    downloads: [],
    description,
    properties,
    ipfsCids,
    downloadPath,
    downloadLabel,
    bookId,
    bookPath,
  };
}

// Sanitizes the JSON payload of GET /papi/book/<id>/formats into the shape the
// frontend renders as "other format" download options.
const FORMAT_DL_PATH_RE = /^\/dl\/[A-Za-z0-9]+$/;
const FORMAT_EXTENSION_RE = /^[a-z0-9]{1,10}$/i;

export function parseZlibFormats(payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!data || !Array.isArray(data.books)) {
    return [];
  }

  const formats = [];
  for (const book of data.books) {
    const extension = String(book?.extension || "").toLowerCase();
    const downloadPath = String(book?.href || "");
    if (!FORMAT_EXTENSION_RE.test(extension) || !FORMAT_DL_PATH_RE.test(downloadPath)) {
      continue;
    }
    formats.push({
      id: Number.isSafeInteger(book?.id) ? book.id : null,
      extension,
      filesize: typeof book?.filesizeString === "string" ? book.filesizeString : "",
      downloadPath,
      lowQuality: book?.isLowQuality === true || book?.isLowQuality === 1,
    });
  }
  return formats;
}
