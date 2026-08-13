import { useCallback, useEffect, useState } from "react"
import { BookOpenIcon, SearchIcon, SearchXIcon } from "lucide-react"

import { BookCard } from "@/components/book-card"
import { BookDetailDialog } from "@/components/book-detail-dialog"
import { GithubIcon } from "@/components/github-icon"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type {
  Book,
  CatalogSource,
  SearchPayload,
  ZlibSearchPayload,
} from "@/lib/search"
import { searchBooks, searchZlib, sourceSearchUrl, ChallengeFailedError } from "@/lib/search"

type Mode = "open" | "source"

type SearchState =
  | { status: "idle" }
  | { status: "loading"; mode: Mode }
  | { status: "done"; mode: Mode; payload: SearchPayload | ZlibSearchPayload }
  | { status: "error"; mode: Mode; challengeFailed: boolean }

// True when the worker answered but the upstream Z-Library fetch failed
// (transient 5xx after its internal retries) — the source badge reports
// ok: false and results is empty, which must not look like "no matches".
function zlibSourceFailed(state: SearchState): boolean {
  return (
    state.status === "done" &&
    state.mode === "source" &&
    !(state.payload as ZlibSearchPayload).sources.zlib.ok
  )
}

// True when the upstream failure was a rate limit (HTTP 429): the visitor
// gets a dedicated hint instead of the generic "search unavailable" text.
function zlibRateLimited(state: SearchState): boolean {
  return (
    state.status === "done" &&
    state.mode === "source" &&
    (state.payload as ZlibSearchPayload).sources.zlib.rateLimited === true
  )
}

function statusText(state: SearchState, verifying: boolean, loadTick: number): string {
  switch (state.status) {
    case "loading":
      // The worker solves upstream challenges and retries 429/5xx on its
      // own, so a cold search can sit in "searching" for several seconds —
      // progress the text with elapsed time instead of looking stuck.
      if (verifying) return "正在通过人机验证…"
      if (loadTick >= 8) return "仍在等待源站响应…"
      if (loadTick >= 3) return "源站响应较慢，正在重试…"
      return "搜索中…"
    case "done":
      return zlibSourceFailed(state)
        ? zlibRateLimited(state)
          ? "源站限流"
          : "搜索暂不可用"
        : `共 ${state.payload.results.length} 项结果`
    case "error":
      return state.challengeFailed ? "人机验证未通过" : "搜索暂不可用"
    default:
      return ""
  }
}

function SourceBadge({ label, source }: { label: string; source: CatalogSource }) {
  return (
    <Badge variant={source.ok ? "secondary" : "outline"}>
      {label} {source.ok ? `${source.count} 项` : "暂不可用"}
    </Badge>
  )
}

function ResultSkeleton() {
  return (
    <div className="flex gap-4 rounded-xl border p-4 sm:p-6">
      <Skeleton className="aspect-[9/13] w-16 rounded-md sm:w-[72px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-7 w-32" />
      </div>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof BookOpenIcon
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}

const GITHUB_REPO_URL = "https://github.com/lieyanc/z-library-proxy"

// Polls the worker's build version and reloads the tab when a deploy lands,
// so long-lived tabs never keep running a stale bundle. The HTML itself is
// no-store and asset URLs carry a content hash, so a reload always fetches
// the newest build.
function useDeployReload(buildCommit: string) {
  useEffect(() => {
    if (!buildCommit || buildCommit === "unknown") return
    let reloaded = false
    const check = async () => {
      if (reloaded) return
      try {
        const response = await fetch("/__z/api/version", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        })
        if (!response.ok) return
        const payload = (await response.json()) as { commit?: string }
        if (payload.commit && payload.commit !== "unknown" && payload.commit !== buildCommit) {
          reloaded = true
          location.reload()
        }
      } catch {
        // Offline or transient failure — try again on the next trigger.
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void check()
    }
    const timer = setInterval(check, 10 * 60 * 1000)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [buildCommit])
}

export default function App({
  initialQuery,
  upstreamHost,
  buildCommit = "",
}: {
  initialQuery: string
  upstreamHost: string
  buildCommit?: string
}) {
  const [mode, setMode] = useState<Mode>("source")
  const [query, setQuery] = useState(initialQuery)
  const [state, setState] = useState<SearchState>({ status: "idle" })
  const [verifying, setVerifying] = useState(false)
  const [selectedBook, setSelectedBook] = useState<Book | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [sourceRenderOpen, setSourceRenderOpen] = useState(false)

  const runSearch = useCallback(async (value: string, searchMode: Mode) => {
    const trimmed = value.trim()
    if (!trimmed) return
    history.replaceState(null, "", `/?q=${encodeURIComponent(trimmed)}`)
    setVerifying(false)
    setState({ status: "loading", mode: searchMode })
    try {
      const payload =
        searchMode === "source"
          ? await searchZlib(trimmed, 1, setVerifying)
          : await searchBooks(trimmed)
      setState({ status: "done", mode: searchMode, payload })
    } catch (error) {
      setState({
        status: "error",
        mode: searchMode,
        challengeFailed: error instanceof ChallengeFailedError,
      })
    } finally {
      setVerifying(false)
    }
  }, [])

  const switchMode = useCallback(
    (nextMode: Mode) => {
      setMode(nextMode)
      if (query.trim()) {
        void runSearch(query, nextMode)
      }
    },
    [query, runSearch],
  )

  useEffect(() => {
    if (initialQuery.trim()) {
      void runSearch(initialQuery, "source")
    }
  }, [initialQuery, runSearch])

  const openDetail = useCallback((book: Book) => {
    setSelectedBook(book)
    setDetailOpen(true)
  }, [])

  const loading = state.status === "loading"
  const results = state.status === "done" ? state.payload.results : []
  const zlibFailed = zlibSourceFailed(state)
  const challengeFailed = state.status === "error" && state.challengeFailed

  // Seconds since the current search started; drives the phased loading
  // status ("搜索中…" → "正在重试…" → "仍在等待…") while the worker
  // handles upstream challenges and retries server-side.
  const [loadTick, setLoadTick] = useState(0)
  useEffect(() => {
    if (!loading) return
    setLoadTick(0)
    const timer = setInterval(() => setLoadTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [loading])

  const retrySearch = () => {
    if (state.status === "error" || state.status === "done") {
      void runSearch(query, state.mode)
    }
  }
  const showCommit = buildCommit !== "" && buildCommit !== "unknown"
  useDeployReload(buildCommit)

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-lg font-bold tracking-tight"
            >
              <GithubIcon className="size-5" />
              lieyanc/z-library-proxy
            </a>
            {showCommit && (
              <a
                href={`${GITHUB_REPO_URL}/commit/${buildCommit}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-muted-foreground hover:text-foreground"
              >
                @{buildCommit}
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              render={<a href="/" aria-label="搜索主页" title="搜索主页" />}
            >
              <SearchIcon />
            </Button>
            <Button variant="ghost" render={<a href="/login" />}>
              {upstreamHost ? `${upstreamHost}账户` : "源站账户"}
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-12 sm:py-16">
        <section
          className="flex flex-col items-center gap-6"
          aria-labelledby="search-title"
        >
          <h1
            id="search-title"
            className="text-center text-3xl font-bold tracking-tight sm:text-4xl"
          >
            查找书籍
          </h1>
          <form
            className="w-full max-w-2xl"
            role="search"
            onSubmit={(event) => {
              event.preventDefault()
              void runSearch(query, mode)
            }}
          >
            <InputGroup className="h-11">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={200}
                autoComplete="off"
                placeholder="书名、作者或 ISBN"
                aria-label="书名、作者或 ISBN"
                required
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="sm"
                  disabled={loading}
                >
                  {loading && <Spinner data-icon="inline-start" />}
                  搜索
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <ToggleGroup
            variant="outline"
            value={[mode]}
            onValueChange={(values) => {
              // Clicking the already-active item reports an empty value;
              // only switching to the other mode may trigger a new search.
              if (values.includes("source")) {
                if (mode !== "source") switchMode("source")
              } else if (values.includes("open")) {
                if (mode !== "open") switchMode("open")
              }
            }}
            aria-label="搜索范围"
          >
            <ToggleGroupItem
              value="source"
              onClick={() => {
                // A second click on the active Z-Library toggle offers the
                // original source-site rendering instead of re-searching.
                if (mode === "source" && query.trim()) {
                  setSourceRenderOpen(true)
                }
              }}
            >
              Z-Library
            </ToggleGroupItem>
            <ToggleGroupItem value="open">开放资源</ToggleGroupItem>
          </ToggleGroup>
        </section>
        {state.status !== "idle" && (
          <section aria-live="polite" className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">
                {state.mode === "source" ? "Z-Library" : "开放资源"}
              </h2>
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {(loading || verifying) && <Spinner className="size-3.5" />}
                {statusText(state, verifying, loadTick)}
              </p>
            </div>
            <Separator />
            {state.status === "done" && (
              <div className="flex flex-wrap gap-2">
                {state.mode === "source" ? (
                  <SourceBadge
                    label="Z-Library"
                    source={(state.payload as ZlibSearchPayload).sources.zlib}
                  />
                ) : (
                  <>
                    <SourceBadge
                      label="Project Gutenberg"
                      source={(state.payload as SearchPayload).sources.gutenberg}
                    />
                    <SourceBadge
                      label="Open Library"
                      source={(state.payload as SearchPayload).sources.openlibrary}
                    />
                  </>
                )}
              </div>
            )}
            {state.status === "loading" && (
              <div className="flex flex-col gap-4">
                <ResultSkeleton />
                <ResultSkeleton />
                <ResultSkeleton />
              </div>
            )}
            {state.status === "done" &&
              !zlibFailed &&
              (results.length > 0 ? (
                <ol className="flex flex-col gap-4">
                  {results.map((book) => (
                    <li key={book.id}>
                      <BookCard
                        book={book}
                        onSelect={state.mode === "source" ? openDetail : undefined}
                      />
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState
                  icon={BookOpenIcon}
                  title={state.mode === "source" ? "Z-Library 没有匹配结果" : "没有找到可公开阅读的结果"}
                  description="换个关键词试试"
                />
              ))}
            {(state.status === "error" || zlibFailed) && (
              <EmptyState
                icon={SearchXIcon}
                title={
                  challengeFailed
                    ? "人机验证未通过"
                    : zlibRateLimited(state)
                      ? "源站限流"
                      : "搜索暂不可用"
                }
                description={
                  challengeFailed
                    ? "已多次尝试通过源站的人机验证，源站仍拒绝了请求，通常意味着当前网络出口被临时限制，请稍等片刻再重试"
                    : zlibRateLimited(state)
                      ? "Z-Library 源站暂时限制了访问频率，请稍等片刻再重试"
                      : state.mode === "source"
                        ? "Z-Library 服务暂时不可用，请稍后重试"
                        : "开放资源服务暂时不可用，请稍后重试"
                }
                action={
                  <Button variant="outline" onClick={retrySearch}>
                    重试
                  </Button>
                }
              />
            )}
          </section>
        )}
      </main>
      <BookDetailDialog
        book={selectedBook}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
      <Dialog open={sourceRenderOpen} onOpenChange={setSourceRenderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>使用原始样式渲染？</DialogTitle>
            <DialogDescription>
              将跳转到 Z-Library 源站搜索页，以原始页面样式展示“{query.trim()}”的结果。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              取消
            </DialogClose>
            <Button
              onClick={() => {
                window.location.href = sourceSearchUrl(query)
              }}
            >
              跳转源站
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
