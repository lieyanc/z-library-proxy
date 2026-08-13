import type { Challenge } from "@/lib/pow"
import { solveChallenge, submitChallengeSolution } from "@/lib/pow"

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
  bookId?: string | null
  accountConfigured?: boolean
}

export interface ZlibFormat {
  id: number | null
  extension: string
  filesize: string
  downloadPath: string
  lowQuality: boolean
}

export interface ZlibFormatsPayload {
  bookId: string
  formats: ZlibFormat[]
}

// Maps a /dl/<hash> source path to the worker-side account download relay.
export function workerDownloadUrl(downloadPath: string | null | undefined): string | null {
  if (!downloadPath) return null
  const match = downloadPath.match(/^\/dl\/([A-Za-z0-9]+)$/)
  return match ? `/__z/dl/${match[1]}` : null
}

export interface CatalogSource {
  ok: boolean
  count: number
  // Set by the worker when the upstream search was rate-limited (HTTP 429)
  // after its internal retries — the UI shows a dedicated prompt for it.
  rateLimited?: boolean
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
  challenge?: Challenge | null
  sources: {
    zlib: CatalogSource
  }
}

export interface IpfsGatewayProbe {
  id: string
  label: string
  url: string
  ok: boolean
  latencyMs: number | null
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

// Fetches a JSON API that may answer with a delegated PoW challenge
// (503 + challenge payload). Solves it locally, submits the token to the
// worker, and retries. `onVerifying` fires while a solve is in progress.
async function fetchWithChallenge<T>(
  url: string,
  onVerifying?: (verifying: boolean) => void,
): Promise<T> {
  let response = await fetch(url, { headers: { Accept: "application/json" } })

  for (let attempt = 0; attempt < 3 && response.status === 503; attempt += 1) {
    const payload = await response.json().catch(() => null)
    const challenge = payload?.challenge as Challenge | undefined
    if (!challenge) break

    onVerifying?.(true)
    let solved = false
    try {
      const solution = await solveChallenge(challenge)
      if (solution) {
        await submitChallengeSolution({ ...solution, bsrv: challenge.bsrv })
        solved = true
      }
    } finally {
      onVerifying?.(false)
    }
    if (!solved) break

    response = await fetch(url, { headers: { Accept: "application/json" } })
  }

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function searchZlib(
  query: string,
  page = 1,
  onVerifying?: (verifying: boolean) => void,
): Promise<ZlibSearchPayload> {
  const params = new URLSearchParams({ q: query })
  if (page > 1) params.set("page", String(page))
  return fetchWithChallenge<ZlibSearchPayload>(`/__z/api/zsearch?${params}`, onVerifying)
}

export async function fetchZlibBook(
  bookPath: string,
  onVerifying?: (verifying: boolean) => void,
): Promise<ZlibBookDetail> {
  return fetchWithChallenge<ZlibBookDetail>(
    `/__z/api/zbook?path=${encodeURIComponent(bookPath)}`,
    onVerifying,
  )
}

export async function fetchZlibFormats(
  bookId: string,
  onVerifying?: (verifying: boolean) => void,
): Promise<ZlibFormatsPayload> {
  return fetchWithChallenge<ZlibFormatsPayload>(
    `/__z/api/zformats?id=${encodeURIComponent(bookId)}`,
    onVerifying,
  )
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
