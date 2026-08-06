export interface BookDownload {
  label: string
  href: string
}

export interface Book {
  id: string
  source: string
  sourceLabel: string
  rightsLabel: string
  title: string
  authors: string[]
  year: number | null
  languages: string[]
  cover: string | null
  details: string
  downloads: BookDownload[]
}

export interface CatalogSource {
  ok: boolean
  count: number
}

export interface SearchPayload {
  query: string
  results: Book[]
  sources: {
    gutenberg: CatalogSource
    openlibrary: CatalogSource
  }
}

export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

export function sourceSearchUrl(query: string): string {
  const trimmed = query.trim()
  return trimmed ? `/s/${encodeURIComponent(trimmed)}` : "/"
}

export async function searchBooks(query: string): Promise<SearchPayload> {
  const response = await fetch(`/__z/api/search?q=${encodeURIComponent(query)}`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`)
  }
  return response.json()
}
