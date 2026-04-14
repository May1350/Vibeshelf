"use client";

import { XIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import type { MarketplaceQuery } from "@/lib/marketplace/search-params";

interface FilterChipsProps {
  initial: MarketplaceQuery;
}

interface ChipProps {
  children: React.ReactNode;
  ariaLabel: string;
  onRemove: () => void;
}

function Chip({ children, ariaLabel, onRemove }: ChipProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
      <span>{children}</span>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onRemove}
        className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <XIcon className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * Active filter chips with remove-X buttons, rendered above the grid.
 *
 * Each remove button gets an explicit `aria-label` like
 * `"Remove Category: SaaS filter"` so screen readers don't hear a dozen
 * generic "Remove" buttons (Real R2.R2).
 *
 * Removes are client-side URL edits via `useRouter().push()` — this keeps
 * the soft-nav experience. Page resets to 1 on any filter change.
 */
export function FilterChips({ initial }: FilterChipsProps) {
  const router = useRouter();
  const params = useSearchParams();

  const navigate = useCallback(
    (next: URLSearchParams) => {
      next.set("page", "1");
      const qs = next.toString();
      router.push(qs ? `/?${qs}` : "/", { scroll: false });
    },
    [router],
  );

  const removeKey = useCallback(
    (key: string) => {
      const next = new URLSearchParams(params.toString());
      next.delete(key);
      navigate(next);
    },
    [navigate, params],
  );

  // Multi-value chip removal: drop one entry from a CSV-encoded query param
  // (?tags=foo,bar → click X on "foo" → ?tags=bar; last one removes the key).
  const removeFromCsv = useCallback(
    (key: string, value: string) => {
      const current = (params.get(key) ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const remaining = current.filter((t) => t !== value);
      const next = new URLSearchParams(params.toString());
      if (remaining.length > 0) {
        next.set(key, remaining.join(","));
      } else {
        next.delete(key);
      }
      navigate(next);
    },
    [navigate, params],
  );

  const hasAny =
    Boolean(initial.q) ||
    initial.categories.length > 0 ||
    typeof initial.min_score === "number" ||
    Boolean(initial.vibecoding) ||
    initial.tags.length > 0;

  if (!hasAny) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {initial.q && (
        <Chip ariaLabel={`Remove Search: ${initial.q} filter`} onRemove={() => removeKey("q")}>
          Search: {initial.q}
        </Chip>
      )}
      {initial.categories.map((c) => (
        <Chip
          key={c}
          ariaLabel={`Remove Category: ${c} filter`}
          onRemove={() => removeFromCsv("categories", c)}
        >
          Category: {c}
        </Chip>
      ))}
      {typeof initial.min_score === "number" && (
        <Chip
          ariaLabel={`Remove minimum score ${initial.min_score} filter`}
          onRemove={() => removeKey("min_score")}
        >
          {initial.min_score}+ stars
        </Chip>
      )}
      {initial.vibecoding && (
        <Chip
          ariaLabel={`Remove Vibecoding: ${initial.vibecoding} filter`}
          onRemove={() => removeKey("vibecoding")}
        >
          Tool: {initial.vibecoding}
        </Chip>
      )}
      {initial.tags.map((t) => (
        <Chip
          key={t}
          ariaLabel={`Remove tag: ${t} filter`}
          onRemove={() => removeFromCsv("tags", t)}
        >
          {t}
        </Chip>
      ))}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="ml-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Clear all
      </button>
    </div>
  );
}
