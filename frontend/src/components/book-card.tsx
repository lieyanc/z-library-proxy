import { BookOpenIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { Book } from "@/lib/search"
import { safeUrl } from "@/lib/search"

function ActionLink({
  label,
  href,
  primary = false,
}: {
  label: string
  href: string | null
  primary?: boolean
}) {
  return (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      render={<a href={safeUrl(href) ?? "#"} target="_blank" rel="noopener noreferrer" />}
    >
      {label}
    </Button>
  )
}

function BookCover({ cover }: { cover: string | null }) {
  const url = safeUrl(cover)
  const className =
    "aspect-[9/13] w-16 rounded-md border bg-muted object-cover sm:w-[72px]"
  if (url) {
    return (
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        className={className}
      />
    )
  }
  return (
    <div
      className={`${className} flex items-center justify-center text-muted-foreground`}
      aria-label="暂无封面"
    >
      <BookOpenIcon className="size-6" />
    </div>
  )
}

export function BookCard({
  book,
  onSelect,
}: {
  book: Book
  onSelect?: (book: Book) => void
}) {
  const downloads = book.downloads.slice(0, 3)
  const isZlib = book.source === "zlib"

  return (
    <Card className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3">
      <div className="row-span-3 pl-4 sm:pl-6">
        <BookCover cover={book.cover} />
      </div>
      <CardHeader className="gap-1 px-0 pr-4 sm:pr-6">
        <CardTitle className="text-base leading-snug">
          {isZlib && onSelect ? (
            <button
              type="button"
              onClick={() => onSelect(book)}
              className="text-left hover:text-primary hover:underline"
            >
              {book.title}
            </button>
          ) : (
            <a
              href={safeUrl(book.details) ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary hover:underline"
            >
              {book.title}
            </a>
          )}
        </CardTitle>
        <CardDescription>
          {book.authors.join("、") || "作者未知"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1.5 px-0 pr-4 sm:pr-6">
        <Badge variant="secondary">{book.sourceLabel}</Badge>
        <Badge variant="secondary">{book.rightsLabel}</Badge>
        {book.year !== null && <Badge variant="outline">{book.year}</Badge>}
        {book.languages.length > 0 && (
          <Badge variant="outline">
            {book.languages.join(" / ").toUpperCase()}
          </Badge>
        )}
        {book.extension && (
          <Badge variant="outline">{book.extension.toUpperCase()}</Badge>
        )}
        {book.filesize && <Badge variant="outline">{book.filesize}</Badge>}
        {book.rating && <Badge variant="outline">★ {book.rating}</Badge>}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 px-0 pr-4 sm:pr-6">
        {isZlib && onSelect ? (
          <Button size="sm" onClick={() => onSelect(book)}>
            查看详情
          </Button>
        ) : downloads.length > 0 ? (
          <>
            {downloads.map((download, index) => (
              <ActionLink
                key={download.href}
                label={download.label}
                href={download.href}
                primary={index === 0}
              />
            ))}
            <ActionLink label="详情" href={book.details} />
          </>
        ) : (
          <ActionLink label="阅读" href={book.details} primary />
        )}
      </CardFooter>
    </Card>
  )
}
