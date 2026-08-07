import { useCallback, useEffect, useState } from "react"
import { BookOpenIcon, SearchIcon, SearchXIcon } from "lucide-react"

import { BookCard } from "@/components/book-card"
import { BookDetailDialog } from "@/components/book-detail-dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
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
import { searchBooks, searchZlib } from "@/lib/search"

type Mode = "open" | "source"

type SearchState =
  | { status: "idle" }
  | { status: "loading"; mode: Mode }
  | { status: "done"; mode: Mode; payload: SearchPayload | ZlibSearchPayload }
  | { status: "error"; mode: Mode }

function statusText(state: SearchState): string {
  switch (state.status) {
    case "loading":
      return "搜索中…"
    case "done":
      return `${state.payload.results.length} 项结果`
    case "error":
      return "搜索暂不可用"
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
}: {
  icon: typeof BookOpenIcon
  title: string
  description: string
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
    </Empty>
  )
}

export default function App({ initialQuery }: { initialQuery: string }) {
  const [mode, setMode] = useState<Mode>("open")
  const [query, setQuery] = useState(initialQuery)
  const [state, setState] = useState<SearchState>({ status: "idle" })
  const [selectedBook, setSelectedBook] = useState<Book | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const runSearch = useCallback(async (value: string, searchMode: Mode) => {
    const trimmed = value.trim()
    if (!trimmed) return
    history.replaceState(null, "", `/?q=${encodeURIComponent(trimmed)}`)
    setState({ status: "loading", mode: searchMode })
    try {
      const payload =
        searchMode === "source" ? await searchZlib(trimmed) : await searchBooks(trimmed)
      setState({ status: "done", mode: searchMode, payload })
    } catch {
      setState({ status: "error", mode: searchMode })
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
      void runSearch(initialQuery, "open")
    }
  }, [initialQuery, runSearch])

  const openDetail = useCallback((book: Book) => {
    setSelectedBook(book)
    setDetailOpen(true)
  }, [])

  const loading = state.status === "loading"
  const results = state.status === "done" ? state.payload.results : []

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <a href="/" className="text-lg font-bold tracking-tight">
            书库
          </a>
          <div className="flex items-center gap-2">
            <Button variant="ghost" render={<a href="/login" />}>
              源站账户
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
              if (values.includes("source")) {
                switchMode("source")
              } else if (values.includes("open")) {
                switchMode("open")
              }
            }}
            aria-label="搜索范围"
          >
            <ToggleGroupItem value="open">开放资源</ToggleGroupItem>
            <ToggleGroupItem value="source">授权书库</ToggleGroupItem>
          </ToggleGroup>
        </section>
        {state.status !== "idle" && (
          <section aria-live="polite" className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">
                {state.mode === "source" ? "授权书库" : "开放资源"}
              </h2>
              <p className="text-sm text-muted-foreground">{statusText(state)}</p>
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
                  title={state.mode === "source" ? "授权书库没有匹配结果" : "没有找到可公开阅读的结果"}
                  description="换个关键词试试"
                />
              ))}
            {state.status === "error" && (
              <EmptyState
                icon={SearchXIcon}
                title="搜索暂不可用"
                description={
                  state.mode === "source"
                    ? "授权书库服务暂时不可用，请稍后再试"
                    : "开放资源服务暂时不可用，请稍后再试"
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
    </div>
  )
}
