"use client";

import { useTranslations } from "next-intl";
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
 * - Category is multi-select checkboxes (OR semantics). Empty selection = no filter,
 *   so no "Any" pseudo-option is needed (matches tags pattern).
 * - "Any" radio is the first option for min_score/vibecoding because
 *   HTML radios can't be deselected once clicked (Critical R2.C1).
 * - Top-10 tags rendered inline; overflow tucked behind `<details>` "Show all".
 * - `w-72` minimum width is expansion-safe for Korean labels (Real R2.R4).
 */
export function FilterSidebar({ initial, facets, className }: FilterSidebarProps) {
  const t = useTranslations("marketplace.filters");
  const tSearch = useTranslations("marketplace.search");
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
            {t("searchLabel")}
          </label>
          <input
            id="q"
            type="search"
            name="q"
            defaultValue={initial.q ?? ""}
            placeholder={tSearch("placeholder")}
            onChange={debouncedSubmit}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>

        {/* Category — multi-select checkboxes, OR semantics */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("category")}</legend>
          {CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="categories"
                value={c}
                defaultChecked={initial.categories.includes(c)}
                onChange={batchedSubmit}
              />
              <span>{humanize(c)}</span>
              <span className="text-xs text-muted-foreground">({facets.categories[c] ?? 0})</span>
            </label>
          ))}
        </fieldset>

        {/* Quality */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("quality")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="min_score"
              value=""
              defaultChecked={!initial.min_score}
              onChange={batchedSubmit}
            />
            {t("any")}
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
              <span>{t("starsBucket", { min })}</span>
              <span className="text-xs text-muted-foreground">
                ({facets.score_buckets[key] ?? 0})
              </span>
            </label>
          ))}
        </fieldset>

        {/* Vibecoding tool */}
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("tool")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="vibecoding"
              value=""
              defaultChecked={!initial.vibecoding}
              onChange={batchedSubmit}
            />
            {t("any")}
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
          <legend className="text-sm font-medium">{t("tags")}</legend>
          {facets.tags.slice(0, 10).map((tag) => (
            <label key={tag.slug} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="tags"
                value={tag.slug}
                defaultChecked={initial.tags.includes(tag.slug)}
                onChange={batchedSubmit}
              />
              <span>{tag.label}</span>
              <span className="text-xs text-muted-foreground">({tag.count})</span>
            </label>
          ))}
          {hiddenTags.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer py-1 text-sm text-muted-foreground">
                {t("showAll", { count: hiddenTags.length })}
              </summary>
              <div className="mt-1 space-y-1">
                {hiddenTags.map((tag) => (
                  <label key={tag.slug} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="tags"
                      value={tag.slug}
                      defaultChecked={initial.tags.includes(tag.slug)}
                      onChange={batchedSubmit}
                    />
                    <span>{tag.label}</span>
                    <span className="text-xs text-muted-foreground">({tag.count})</span>
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
          {t("apply")}
        </button>
      </form>
    </aside>
  );
}
