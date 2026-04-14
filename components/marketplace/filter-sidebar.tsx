"use client";

import { useRef } from "react";
import { useDebouncedCallback } from "@/lib/marketplace/debounce";
import type { MarketplaceFacets } from "@/lib/marketplace/facets";
import type { MarketplaceQuery } from "@/lib/marketplace/search-params";
import { CATEGORIES, VIBECODING_TOOLS } from "@/lib/marketplace/search-params";

const SCORE_BUCKETS: Array<{ min: number; key: keyof MarketplaceFacets["score_buckets"] }> = [
  { min: 3, key: "min_3" },
  { min: 4, key: "min_4" },
  { min: 4.5, key: "min_4_5" },
];

function humanize(slug: string): string {
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface FilterSidebarProps {
  initial: MarketplaceQuery;
  facets: MarketplaceFacets;
  className?: string;
}

/**
 * Progressive-enhancement marketplace filter sidebar.
 *
 * - `<form action="/" method="GET">`: works with JS disabled (Apply button submits).
 * - Hidden `page=1` input resets pagination on every filter change.
 * - Search: 350ms debounce. Checkboxes/radios: 200ms batched debounce.
 * - "Any" radio is the first option for category/min_score/vibecoding because
 *   HTML radios can't be deselected once clicked (Critical R2.C1).
 * - Top-10 tags rendered inline; overflow tucked behind `<details>` "Show all".
 * - `w-72` minimum width is expansion-safe for Korean labels (Real R2.R4).
 */
export function FilterSidebar({ initial, facets, className }: FilterSidebarProps) {
  const formRef = useRef<HTMLFormElement>(null);

  const submit = () => formRef.current?.requestSubmit();
  const debouncedSubmit = useDebouncedCallback(submit, 350);
  const batchedSubmit = useDebouncedCallback(submit, 200);

  const hiddenTags = facets.tags.slice(10);

  return (
    <aside className={className ?? "hidden w-72 lg:block"}>
      <form ref={formRef} action="/" method="GET" className="space-y-6">
        {/* Reset pagination on every filter change */}
        <input type="hidden" name="page" value="1" />
        {/* Preserve current sort across filter changes */}
        <input type="hidden" name="sort" value={initial.sort} />

        {/* Search */}
        <div>
          <label htmlFor="q" className="text-sm font-medium">
            Search
          </label>
          <input
            id="q"
            type="search"
            name="q"
            defaultValue={initial.q ?? ""}
            placeholder="Search templates..."
            onChange={debouncedSubmit}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>

        {/* Category — radio with explicit "Any" first option (clearable) */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Category</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="category"
              value=""
              defaultChecked={!initial.category}
              onChange={batchedSubmit}
            />
            Any
          </label>
          {CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="category"
                value={c}
                defaultChecked={initial.category === c}
                onChange={batchedSubmit}
              />
              <span>{humanize(c)}</span>
              <span className="text-xs text-muted-foreground">({facets.categories[c] ?? 0})</span>
            </label>
          ))}
        </fieldset>

        {/* Quality */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Quality</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="min_score"
              value=""
              defaultChecked={!initial.min_score}
              onChange={batchedSubmit}
            />
            Any
          </label>
          {SCORE_BUCKETS.map(({ min, key }) => (
            <label key={min} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="min_score"
                value={String(min)}
                defaultChecked={initial.min_score === min}
                onChange={batchedSubmit}
              />
              <span>{min}+ stars</span>
              <span className="text-xs text-muted-foreground">
                ({facets.score_buckets[key] ?? 0})
              </span>
            </label>
          ))}
        </fieldset>

        {/* Vibecoding tool */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Vibecoding tool</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="vibecoding"
              value=""
              defaultChecked={!initial.vibecoding}
              onChange={batchedSubmit}
            />
            Any
          </label>
          {VIBECODING_TOOLS.map((v) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="vibecoding"
                value={v}
                defaultChecked={initial.vibecoding === v}
                onChange={batchedSubmit}
              />
              <span className="capitalize">{v}</span>
              <span className="text-xs text-muted-foreground">({facets.vibecoding[v] ?? 0})</span>
            </label>
          ))}
        </fieldset>

        {/* Feature tags — top-10 visible + <details> overflow, AND semantics */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Features (AND)</legend>
          {facets.tags.slice(0, 10).map((t) => (
            <label key={t.slug} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="tags"
                value={t.slug}
                defaultChecked={initial.tags.includes(t.slug)}
                onChange={batchedSubmit}
              />
              <span>{t.label}</span>
              <span className="text-xs text-muted-foreground">({t.count})</span>
            </label>
          ))}
          {hiddenTags.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer py-1 text-sm text-muted-foreground">
                Show all ({hiddenTags.length})
              </summary>
              <div className="mt-1 space-y-1">
                {hiddenTags.map((t) => (
                  <label key={t.slug} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="tags"
                      value={t.slug}
                      defaultChecked={initial.tags.includes(t.slug)}
                      onChange={batchedSubmit}
                    />
                    <span>{t.label}</span>
                    <span className="text-xs text-muted-foreground">({t.count})</span>
                  </label>
                ))}
              </div>
            </details>
          )}
        </fieldset>

        {/*
          Always-visible submit button. With JS enabled, debounced onChange
          handlers submit automatically so clicks are no-op; without JS, this
          is how users apply filters. Also makes <Enter> in the search input
          submit naturally.
        */}
        <button
          type="submit"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          Apply filters
        </button>
      </form>
    </aside>
  );
}
