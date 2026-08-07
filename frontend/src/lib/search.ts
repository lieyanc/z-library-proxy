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
  // Present on Z-Library results.
  isbn?: string
  publisher?: string
  extension?: string
  filesize?: string
  rating?: string
  downloadPath?: string | null
  bookPath?: string
}

export interface BookProperty {
  key: string
  label: string
  value: string
}

export interface ZlibBookDetail extends Book {
  description: string
  properties: BookProperty[]
  ipfsCids: string[]
  downloadLabel: string
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

export interface ZlibSearchPayload {
  query: string
  page: number
  results: Book[]
  sources: {
    zlib: CatalogSource
  }
}

export interface IpfsGatewayProbe {
  id: string
  label: string
  url: string
  ok: boolean
  latencyMs: number
  kibPerSecond: number
  proxyUrl: string | null
}

export interface IpfsProbePayload {
  cid: string
  path: string
  proxyAllowed: boolean
  gateways: IpfsGatewayProbe[]
}

export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  // Allow same-origin paths produced by the worker (proxied upstream pages).
  if (value.startsWith("/") && !value.startsWith("//")) return value
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

export async function searchZlib(query: string, page = 1): Promise<ZlibSearchPayload> {
  const params = new URLSearchParams({ q: query })
  if (page > 1) params.set("page", String(page))
  const response = await fetch(`/__z/api/zsearch?${params}`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`Z-Library search failed with status ${response.status}`)
  }
  return response.json()
}

export async function fetchZlibBook(bookPath: string): Promise<ZlibBookDetail> {
  const response = await fetch(`/__z/api/zbook?path=${encodeURIComponent(bookPath)}`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`Book details failed with status ${response.status}`)
  }
  return response.json()
}

export async function probeIpfsGateways(cid: string): Promise<IpfsProbePayload> {
  const response = await fetch(`/__z/api/ipfs-probe?cid=${encodeURIComponent(cid)}`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`IPFS probe failed with status ${response.status}`)
  }
  return response.json()
}
