import { useEffect, useState } from "react"
import { BookOpenIcon, CopyIcon, DownloadIcon, GaugeIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { Book, IpfsProbePayload, ZlibBookDetail } from "@/lib/search"
import { fetchZlibBook, probeIpfsGateways, safeUrl, workerDownloadUrl } from "@/lib/search"

type DetailState =
  | { status: "loading" }
  | { status: "done"; detail: ZlibBookDetail }
  | { status: "error" }

function CoverImage({ cover, title }: { cover: string | null; title: string }) {
  const url = safeUrl(cover)
  const className = "aspect-[9/13] w-24 rounded-md border bg-muted object-cover"
  if (url) {
    return <img src={url} alt={title} referrerPolicy="no-referrer" className={className} />
  }
  return (
    <div className={`${className} flex items-center justify-center text-muted-foreground`}>
      <BookOpenIcon className="size-8" />
    </div>
  )
}

function IpfsRow({ cid, filename }: { cid: string; filename: string }) {
  const [probe, setProbe] = useState<IpfsProbePayload | null>(null)
  const [probing, setProbing] = useState(false)
  const [copied, setCopied] = useState(false)

  const runProbe = async () => {
    setProbing(true)
    try {
      setProbe(await probeIpfsGateways(cid))
    } catch {
      setProbe(null)
    } finally {
      setProbing(false)
    }
  }

  const copyCid = async () => {
    try {
      await navigator.clipboard.writeText(cid)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; ignore.
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{cid}</code>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={copyCid}>
            <CopyIcon data-icon="inline-start" />
            {copied ? "已复制" : "复制"}
          </Button>
          <Button size="sm" variant="outline" onClick={runProbe} disabled={probing}>
            {probing ? <Spinner data-icon="inline-start" /> : <GaugeIcon data-icon="inline-start" />}
            测速
          </Button>
        </div>
      </div>
      {probe && (
        <div className="flex flex-col gap-1.5">
          {probe.gateways.map((gateway) => (
            <div key={gateway.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">{gateway.label}</span>
              <span className="text-muted-foreground">
                {gateway.ok ? `${gateway.latencyMs} ms · ${gateway.kibPerSecond} KiB/s` : "测速超时"}
              </span>
              <span className="flex gap-1.5">
                {gateway.proxyUrl && (
                  <Button
                    size="sm"
                    render={
                      <a
                        href={safeUrl(
                          `${gateway.proxyUrl}&filename=${encodeURIComponent(filename)}`,
                        ) ?? "#"}
                      />
                    }
                  >
                    代理下载
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={gateway.proxyUrl ? "outline" : "default"}
                  render={<a href={safeUrl(gateway.url) ?? "#"} target="_blank" rel="noopener noreferrer" />}
                >
                  直连
                </Button>
              </span>
            </div>
          ))}
          {!probe.proxyAllowed && (
            <p className="text-xs text-muted-foreground">此 CID 未加入授权列表，仅提供网关直连</p>
          )}
        </div>
      )}
    </div>
  )
}

export function BookDetailDialog({
  book,
  open,
  onOpenChange,
}: {
  book: Book | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<DetailState>({ status: "loading" })

  useEffect(() => {
    if (!open || !book?.bookPath) return
    setState({ status: "loading" })
    let cancelled = false
    fetchZlibBook(book.bookPath)
      .then((detail) => {
        if (!cancelled) setState({ status: "done", detail })
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" })
      })
    return () => {
      cancelled = true
    }
  }, [open, book?.bookPath])

  const detail = state.status === "done" ? state.detail : null
  const filename = detail
    ? `${detail.title}${detail.extension ? `.${detail.extension}` : ""}`
    : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{book?.title ?? "书籍详情"}</DialogTitle>
          <DialogDescription>{book?.authors.join("、") || "作者未知"}</DialogDescription>
        </DialogHeader>

        {state.status === "loading" && (
          <div className="flex gap-4">
            <Skeleton className="aspect-[9/13] w-24 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        )}

        {state.status === "error" && (
          <p className="text-sm text-muted-foreground">详情加载失败，请稍后重试。</p>
        )}

        {detail && (
          <div className="flex flex-col gap-4">
            <div className="flex gap-4">
              <CoverImage cover={detail.cover} title={detail.title} />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {detail.year !== null && <Badge variant="outline">{detail.year}</Badge>}
                  {detail.languages.map((language) => (
                    <Badge key={language} variant="outline">
                      {language}
                    </Badge>
                  ))}
                  {detail.extension && (
                    <Badge variant="outline">{detail.extension.toUpperCase()}</Badge>
                  )}
                  {detail.filesize && <Badge variant="outline">{detail.filesize}</Badge>}
                  {detail.rating && <Badge variant="outline">★ {detail.rating}</Badge>}
                  {detail.publisher && <Badge variant="outline">{detail.publisher}</Badge>}
                </div>
                {detail.downloadPath && (
                  <div>
                    <Button
                      size="sm"
                      render={
                        <a
                          href={
                            safeUrl(
                              detail.accountConfigured
                                ? workerDownloadUrl(detail.downloadPath)
                                : detail.downloadPath,
                            ) ?? "#"
                          }
                          {...(detail.accountConfigured
                            ? {}
                            : { target: "_blank", rel: "noopener noreferrer" })}
                        />
                      }
                    >
                      <DownloadIcon data-icon="inline-start" />
                      下载{detail.downloadLabel ? `（${detail.downloadLabel}）` : ""}
                    </Button>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {detail.accountConfigured
                        ? "经 Worker 使用已配置账户解析并中转下载"
                        : "下载由源站处理，未登录时会跳转源站登录页"}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {detail.description && (
              <>
                <Separator />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {detail.description}
                </p>
              </>
            )}

            {detail.properties.length > 0 && (
              <>
                <Separator />
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                  {detail.properties.map((property) => (
                    <div key={property.key} className="contents">
                      <dt className="whitespace-nowrap text-muted-foreground">{property.label}</dt>
                      <dd className="min-w-0">{property.value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {detail.ipfsCids.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">IPFS 下载</h3>
                  {detail.ipfsCids.map((cid) => (
                    <IpfsRow key={cid} cid={cid} filename={filename} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
