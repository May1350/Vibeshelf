import Link from "next/link";

export function Pagination({
  currentPage,
  totalPages,
  buildHref,
}: {
  currentPage: number;
  totalPages: number;
  buildHref: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  const pages = pageRange(currentPage, totalPages);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-1 mt-8">
      {pages.map((p, idx) => {
        if (p === "...") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: gap marker, stable per render
            <span key={`gap-${idx}`} className="px-2 text-muted-foreground">
              …
            </span>
          );
        }
        const isCurrent = p === currentPage;
        return (
          <Link
            key={p}
            href={buildHref(p)}
            prefetch
            aria-label={`Go to page ${p} of ${totalPages}`}
            aria-current={isCurrent ? "page" : undefined}
            className={`px-3 py-1 rounded ${
              isCurrent ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-muted"
            }`}
          >
            <span className="sr-only">Page </span>
            {p}
          </Link>
        );
      })}
    </nav>
  );
}

function pageRange(current: number, total: number): Array<number | "..."> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const result: Array<number | "..."> = [1];
  if (current > 3) result.push("...");
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) result.push(p);
  if (current < total - 2) result.push("...");
  result.push(total);
  return result;
}
