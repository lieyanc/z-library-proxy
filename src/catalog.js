const RESULT_LIMIT = 12;
const REQUEST_TIMEOUT_MS = 9000;

function validHttpsUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstFormat(formats, mimeTypes) {
  for (const mimeType of mimeTypes) {
    const directMatch = validHttpsUrl(formats[mimeType]);
    if (directMatch) {
      return directMatch;
    }

    const matchingEntry = Object.entries(formats).find(([key]) => key.startsWith(mimeType));
    const matchingUrl = validHttpsUrl(matchingEntry?.[1]);
    if (matchingUrl) {
      return matchingUrl;
    }
  }

  return null;
}

export function normalizeGutenbergBooks(payload) {
  if (!Array.isArray(payload?.results)) {
    return [];
  }

  return payload.results
    .filter((book) => book?.copyright === false && Number.isInteger(book.id))
    .slice(0, RESULT_LIMIT)
    .map((book) => {
      const formats = book.formats && typeof book.formats === "object" ? book.formats : {};
      const downloads = [
        ["EPUB", firstFormat(formats, ["application/epub+zip"])],
        ["HTML", firstFormat(formats, ["text/html"])],
        ["TXT", firstFormat(formats, ["text/plain"])],
      ]
        .filter(([, href]) => href)
        .map(([label, href]) => ({ label, href }));

      return {
        id: `gutenberg:${book.id}`,
        source: "gutenberg",
        sourceLabel: "Project Gutenberg",
        rightsLabel: "公版",
        title: String(book.title || "未命名书籍"),
        authors: Array.isArray(book.authors)
          ? book.authors.map((author) => String(author?.name || "")).filter(Boolean)
          : [],
        year: null,
        languages: Array.isArray(book.languages) ? book.languages.slice(0, 4) : [],
        cover: firstFormat(formats, ["image/jpeg"]),
        details: `https://www.gutenberg.org/ebooks/${book.id}`,
        downloads,
      };
    });
}

export function normalizeOpenLibraryBooks(payload) {
  if (!Array.isArray(payload?.docs)) {
    return [];
  }

  return payload.docs
    .filter(
      (book) =>
        book?.ebook_access === "public" &&
        book?.public_scan_b === true &&
        typeof book.key === "string" &&
        book.key.startsWith("/works/"),
    )
    .slice(0, RESULT_LIMIT)
    .map((book) => ({
      id: `openlibrary:${book.key}`,
      source: "openlibrary",
      sourceLabel: "Open Library",
      rightsLabel: "公开阅读",
      title: String(book.title || "未命名书籍"),
      authors: Array.isArray(book.author_name)
        ? book.author_name.map((author) => String(author)).filter(Boolean).slice(0, 4)
        : [],
      year: Number.isInteger(book.first_publish_year) ? book.first_publish_year : null,
      languages: Array.isArray(book.language) ? book.language.slice(0, 4) : [],
      cover: Number.isInteger(book.cover_i)
        ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
        : null,
      details: `https://openlibrary.org${book.key}`,
      downloads: [],
    }));
}

async function fetchJson(url, fetcher) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Catalog returned ${response.status}`);
  }

  return response.json();
}

export async function searchOpenCatalogs(query, fetcher = fetch) {
  const normalizedQuery = query.trim().slice(0, 200);
  const gutenbergUrl = new URL("https://gutendex.com/books/");
  gutenbergUrl.searchParams.set("search", normalizedQuery);
  gutenbergUrl.searchParams.set("copyright", "false");

  const openLibraryUrl = new URL("https://openlibrary.org/search.json");
  openLibraryUrl.searchParams.set("q", `${normalizedQuery} ebook_access:public`);
  openLibraryUrl.searchParams.set(
    "fields",
    "key,title,author_name,cover_i,first_publish_year,language,ebook_access,public_scan_b",
  );
  openLibraryUrl.searchParams.set("limit", String(RESULT_LIMIT));

  const [gutenberg, openLibrary] = await Promise.allSettled([
    fetchJson(gutenbergUrl, fetcher),
    fetchJson(openLibraryUrl, fetcher),
  ]);

  const gutenbergBooks =
    gutenberg.status === "fulfilled" ? normalizeGutenbergBooks(gutenberg.value) : [];
  const openLibraryBooks =
    openLibrary.status === "fulfilled" ? normalizeOpenLibraryBooks(openLibrary.value) : [];

  return {
    query: normalizedQuery,
    results: [...gutenbergBooks, ...openLibraryBooks],
    sources: {
      gutenberg: {
        ok: gutenberg.status === "fulfilled",
        count: gutenbergBooks.length,
      },
      openlibrary: {
        ok: openLibrary.status === "fulfilled",
        count: openLibraryBooks.length,
      },
    },
  };
}
