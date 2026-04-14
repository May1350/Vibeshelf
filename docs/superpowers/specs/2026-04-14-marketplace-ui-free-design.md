---
title: VibeShelf Marketplace UI (Free) — Design Spec
date: 2026-04-14
status: draft (pending user approval)
sub_project: 04-marketplace-ui-free
parent_prd: VibeShelf_PRD_Final.md
related_docs:
  - docs/superpowers/specs/2026-04-11-foundation-design.md
  - docs/superpowers/specs/2026-04-14-evaluation-classification-design.md
  - docs/architecture/future-separation-plan.md
  - docs/architecture/open-questions.md
prior_sub_projects:
  - PR #1 Foundation merged 2026-04-13
  - PR #2 Ingestion Pipeline merged 2026-04-14
  - PR #4 Evaluation + Classification (in review)
---

# VibeShelf Marketplace UI (Free) — Design Spec

**Sub-project #4 of 6.** First user-facing UI work. Builds on Foundation + Ingestion Pipeline + Evaluation Pipeline.

Purpose: ship a usable marketplace where vibe coders can discover, filter, sort, and inspect curated GitHub templates. Pinterest-style image-first grid; URL-driven filters (shareable); WCAG 2.1 AA accessible; SSR/RSC for SEO and first-paint perf.

---

## 0. Scope

**In scope:**
- `/` marketplace home: filter sidebar + sort + paginated grid (36/page, masonry)
- `/r/[owner]/[name]` repo detail page (score breakdown, README preview, GitHub link, fork CTA placeholder)
- Search bar (name + description only — no README content yet)
- 12 categories (saas/ecommerce/dashboard/landing_page/ai_tool/utility/game/portfolio/blog/chatbot/mobile_app/other)
- 30 canonical feature tags + tech_stack tags + vibecoding_tool tags as filter facets
- Quality score filter (3+, 4+, 4.5+)
- Fork CTA button (placeholder — no flow until #5)
- Reviews section placeholder ("Be the first to review after forking")
- Image rendering via `next/image` with `remotePatterns` allowlist (NO camo)
- Above-fold GIF autoplay; below-fold lazy
- Mobile bottom-sheet drawer for filters

**Out of scope (deferred):**
- Sub-project #4.5 (post-MVP): pipeline-side image mirror to Supabase Storage + GIF→MP4 + width/height capture
- Search over README body content
- Review badges (score data exists but UI lives in #5)
- Authentication header changes (sign-in stays as-is; can be moved to header in #5)
- Admin promotion UI for `status='scored'` / `'needs_review'` repos (operator uses Supabase Studio + SQL snippets from #3)
- Reviewed-rating sort (renders as disabled "Coming soon" until #5)

---

## 1. Architecture

### Page set

```
app/
├── page.tsx                                 (RSC, async PageProps<'/'>)
├── loading.tsx                              (NEW — route-level fallback)
├── error.tsx                                (NEW — global error boundary)
├── sitemap.ts                               (NEW — published repos + canonical category pages)
├── r/
│   └── [owner]/
│       └── [name]/
│           ├── page.tsx                     (RSC, generateMetadata + JSON-LD)
│           ├── not-found.tsx                (NEW — segment-scoped 404)
│           └── loading.tsx                  (NEW)
├── (auth)/                                  (existing)
└── api/cron/                                (existing — score/refresh/discover/dormant/rescore/prune route handlers extended)
```

### Component layout

```
components/marketplace/
├── repo-card.tsx                            (RSC, image-first, link wraps image+title only)
├── repo-grid.tsx                            (RSC, Pinterest masonry via react-masonry-css)
├── filter-sidebar.tsx                       (CLIENT — minimal: <form action="/" method="GET">)
├── filter-chips.tsx                         (CLIENT — active filter X-removal buttons)
├── sort-dropdown.tsx                        (CLIENT — submits parent form on change)
├── pagination.tsx                           (RSC — Next <Link prefetch> with aria-current)
├── empty-state.tsx                          (RSC — recovery CTA + 4-6 high-score recommendations)
├── grid-skeleton.tsx                        (RSC — Suspense fallback)
└── filter-drawer.tsx                        (CLIENT — shadcn Sheet for mobile)

components/repo/
├── repo-hero.tsx                            (RSC — hero image + title + meta sidebar)
├── score-badge.tsx                          (RSC — color + number + tier text + role="img" + aria-label)
├── score-breakdown.tsx                      (RSC — 5 axes as progress bars on detail page)
├── tags-list.tsx                            (RSC — group by kind)
├── readme-preview.tsx                       (RSC — DOMPurify-sanitized HTML)
├── fork-cta-placeholder.tsx                 (RSC — disabled button "Fork (sign in required)")
├── reviews-placeholder.tsx                  (RSC — "Be the first to review after forking")
└── json-ld.tsx                              (RSC — SoftwareApplication structured data)

lib/marketplace/
├── search-params.ts                         (zod schema validation)
├── queries.ts                               ('use server-only' — listRepos, getRepo)
├── facets.ts                                ('use server-only' — getMarketplaceFacets, 'use cache')
├── score-tier.ts                            (pure — score → "Excellent" | "Good" | "Fair" | "Limited")
└── debounce.ts                              (pure — for client-side search input)
```

### Data flow

1. `app/page.tsx` is RSC; `props.searchParams` is `Promise<...>`; **MUST await** (Next 16 contract)
2. `parseMarketplaceParams(await props.searchParams)` → typed query object
3. Page renders shell synchronously: header + filter sidebar (data from cached `getMarketplaceFacets()`) + skeleton
4. `<Suspense fallback={<GridSkeleton/>}>` wraps async server component that calls `listRepos(query)`
5. Filter sidebar = client component using `<form action="/" method="GET">` with onChange-submit → URL navigation → RSC re-render. **No JS = form submit on Apply button works**
6. Sort dropdown = same form, `<select onChange={form.requestSubmit}>`
7. Search input = same form, **debounced 350ms** before form submit
8. Filter sidebar lives OUTSIDE the Suspense boundary → stays interactive while grid re-streams

### Foundation boundary (preserved)

- DB access: `lib/db/anon-client.ts` (anon key + RLS `repos_select_published`)
- `lib/marketplace/queries.ts` and `facets.ts` use `import 'server-only'` — Client Components cannot import them
- New dep-cruiser rules added (see §6)

---

## 2. URL contract

### Search params schema

```typescript
// lib/marketplace/search-params.ts
import { z } from 'zod';

const CATEGORIES = ['saas','ecommerce','dashboard','landing_page','ai_tool',
                    'utility','game','portfolio','blog','chatbot','mobile_app','other'] as const;
const VIBECODING = ['cursor','bolt','lovable','replit'] as const;
const SORTS = ['score','recent','popular'] as const;

export const MarketplaceParams = z.object({
  q:           z.string().trim().min(1).max(100).optional(),
  category:    z.enum(CATEGORIES).optional(),
  tags:        z.string().optional()
                 .transform(s => s ? s.split(',').filter(Boolean) : []),
  min_score:   z.coerce.number().min(0).max(5).optional(),
  vibecoding:  z.enum(VIBECODING).optional(),
  sort:        z.enum(SORTS).default('score'),
  page:        z.coerce.number().int().min(1).default(1),
});
export type MarketplaceQuery = z.infer<typeof MarketplaceParams>;
```

### Empty-array convention

`tags` array must always be `[]` (never `null`). Zod transform enforces. `lib/marketplace/queries.ts` callers also pass `[]` as the SQL parameter — never `null`.

### Sample URLs

- `/?q=stripe&category=saas&min_score=4&sort=score`
- `/?tags=auth,payments,dark_mode&page=2` (AND semantics — repo must have ALL three)
- `/?vibecoding=cursor&sort=recent`

### Robots / sitemap

| Route | robots | sitemap |
|---|---|---|
| `/` | index, follow | yes |
| `/?category=saas` (single canonical param) | index, follow | yes (one entry per category) |
| `/?category=saas&tags=...&sort=...&page=...` (combinations) | **noindex, follow** | no |
| `/r/[owner]/[name]` | index, follow | yes (one entry per published repo) |

`app/sitemap.ts` is `'use cache' + cacheLife('hours') + cacheTag('repos:list')`. Rebuilds via tag invalidation when ingest jobs flip repo set.

---

## 3. Cache strategy (Next 16 Cache Components)

### Enable in `next.config.ts`

```typescript
export default {
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'user-images.githubusercontent.com' },
      { protocol: 'https', hostname: 'github.com' },
      // NOT camo.githubusercontent.com — proxies arbitrary URLs, SSRF/abuse risk.
      // Mirror via SP#4.5 to Supabase Storage to support camo content safely.
    ],
    formats: ['image/avif', 'image/webp'],
  },
};
```

Remove `export const dynamic = "force-dynamic"` from `app/page.tsx` (Next 16 default is dynamic; the export is dead code).

### Cache contract per route

| Route | Strategy |
|---|---|
| `/` (no params) | shell PPR + facets `'use cache'` (tagged `repos:facets`) |
| `/?q=...` | NO cache for results (live search); facets cached normally |
| `/?category=...` (single canonical param) | full PPR — list + facets both cached |
| `/?category=...&tags=...&...` (combinations) | dynamic — params drive query, no caching |
| `/r/[owner]/[name]` | `'use cache'` + `cacheTag('repo:${id}')` + `cacheLife('days')` |

**Critical:** `'use cache'` functions CANNOT read `searchParams` directly (Next 16 build hangs). Pattern:

```typescript
// app/page.tsx
export default async function Page(props: PageProps<'/'>) {
  const sp = await props.searchParams;
  const query = parseMarketplaceParams(sp);
  const facets = await getMarketplaceFacets();        // zero-arg cached
  const repos = await listRepos(query);               // arg drives cache key
  // ...
}

// lib/marketplace/facets.ts
'use cache';
import { cacheTag, cacheLife } from 'next/cache';
export async function getMarketplaceFacets() {
  cacheTag('repos:facets');
  cacheLife('hours');
  return /* aggregation result */;
}
```

### Cache invalidation wiring

**Critical wiring fix from reviewer C2 (R1):** Pipeline jobs must surface changed repo IDs.

```typescript
// lib/types/jobs.ts (extend JobOutput contract — soft, optional field)
export interface JobOutput {
  changedRepoIds?: readonly string[];
  [key: string]: unknown;
}
```

Each ingest job (`discover`, `score`, `rescore`, `refresh`) collects upserted/updated repo IDs:

```typescript
// In each job's per-repo loop:
const changedIds: string[] = [];
// On state-changing upsert (xmax=0 RETURNING for tight semantics, OR accept all upserts):
const { data, error } = await ctx.db.from('repos').upsert(...).select('id, xmax').single();
if (data?.xmax === '0' || true) changedIds.push(data.id);  // simplest: all upserts trigger
return { ..., changedRepoIds: changedIds };
```

Cron route handles invalidation (Foundation rule 9: `lib/pipeline/` cannot import `next/cache`):

```typescript
// app/api/cron/score/route.ts (and discover, refresh, rescore)
import { revalidateTag } from 'next/cache';

const result = await runJob('ingest-score', {}, ctx => scoreJob(ctx));
const ids = result.changedRepoIds ?? [];
if (ids.length > 0) {
  revalidateTag('repos:facets', 'max');     // single-arg form deprecated in Next 16
  revalidateTag('repos:list', 'max');
  for (const id of ids) revalidateTag(`repo:${id}`, 'max');
}
return Response.json(result);
```

**Note:** `revalidateTag(tag, 'max')` is stale-while-revalidate. First post-cron visitor sees stale, background refetch populates cache. Acceptable for marketplace.

---

## 4. Components

### 4.1 Pinterest masonry grid

Use `react-masonry-css` (~5KB) for left-to-right row order — preserves score ranking. CSS columns alternative inverts visual order (column 1 top→bottom, then column 2) and breaks score-ranked feed UX.

```tsx
// components/marketplace/repo-grid.tsx (RSC)
import Masonry from 'react-masonry-css';
const breakpointCols = { default: 4, 1280: 3, 768: 2, 640: 1 };
<Masonry breakpointCols={breakpointCols} className="flex gap-4" columnClassName="flex flex-col gap-4">
  {repos.map(r => <RepoCard key={r.id} repo={r} />)}
</Masonry>
```

36 repos per page. CLS partially accepted (no width/height in this MVP — fix in #4.5 mirror with image probe).

### 4.2 RepoCard (image-first)

```tsx
// components/marketplace/repo-card.tsx (RSC)
<article className="rounded-lg overflow-hidden border bg-card">
  <Link href={`/r/${repo.owner}/${repo.name}`}>
    {repo.hero_asset && (
      <Image
        src={repo.hero_asset.external_url}
        alt={`${repo.owner}/${repo.name} preview`}
        width={400}
        height={300}                                   /* defaults; CLS until #4.5 */
        unoptimized={repo.hero_asset.kind === 'readme_gif'}
        loading={isAboveFold ? 'eager' : 'lazy'}      /* first 8 cards eager */
        fetchPriority={isAboveFold ? 'auto' : 'low'}
        className="w-full h-auto"
      />
    )}
    <h3 className="font-medium line-clamp-2">{repo.owner}/{repo.name}</h3>   {/* Korean expansion-safe */}
  </Link>
  <div className="p-3 space-y-2">
    <div className="flex items-center gap-3 text-sm">
      <ScoreBadge score={repo.total_score} />
      <span className="text-muted-foreground">⭐ {formatStars(repo.stars)}</span>
    </div>
    <ul className="flex flex-wrap gap-1" aria-label="Tags">
      {repo.feature_tags.slice(0, 3).map(t => <li key={t}><Badge>{t}</Badge></li>)}
    </ul>
  </div>
  {/* Hover overlay (CSS-only, gated by media query for touch) */}
  <div
    aria-hidden="true"
    className="absolute inset-0 bg-black/60 text-white p-4 opacity-0 transition-opacity
               hover:opacity-100 [@media(hover:hover)]:[&]:block hidden"
  >
    {repo.description}
  </div>
</article>
```

### 4.3 ScoreBadge (a11y)

```tsx
// components/repo/score-badge.tsx (RSC)
import { scoreTier } from '@/lib/marketplace/score-tier';

export function ScoreBadge({ score }: { score: number }) {
  const tier = scoreTier(score);  // "Excellent" | "Good" | "Fair" | "Limited"
  const colorClass = tier === "Excellent" ? "text-yellow-500" : tier === "Good" ? "text-green-500" : ...;
  return (
    <div
      role="img"
      aria-label={`Quality score ${score.toFixed(1)} of 5, ${tier}`}
      className="flex items-center gap-1"
    >
      <Star className={colorClass} aria-hidden="true" />
      <span className="font-semibold">{score.toFixed(1)}</span>
      <span className="text-xs text-muted-foreground">/5 · {tier}</span>
    </div>
  );
}
```

### 4.4 FilterSidebar

```tsx
// components/marketplace/filter-sidebar.tsx (CLIENT)
'use client';

const SCORE_BUCKETS = [3, 4, 4.5];

export function FilterSidebar({ initial, facets }) {
  const formRef = useRef<HTMLFormElement>(null);
  const debouncedSubmit = useDebouncedCallback(() => formRef.current?.requestSubmit(), 350);
  const batchedSubmit = useDebouncedCallback(() => formRef.current?.requestSubmit(), 200);

  return (
    <aside className="w-72 hidden lg:block">                                {/* Korean expansion-safe min */}
      <form ref={formRef} action="/" method="GET" className="space-y-6">
        <input type="hidden" name="page" value="1" />                       {/* reset on filter change */}

        {/* Search */}
        <div>
          <label htmlFor="q" className="text-sm font-medium">Search</label>
          <input
            id="q" type="search" name="q"
            defaultValue={initial.q ?? ''}
            placeholder="Search templates..."
            onChange={debouncedSubmit}                                       {/* 350ms debounce */}
            className="w-full mt-1 ..."
          />
        </div>

        {/* Category — radio with explicit "Any" first option (clearable) */}
        <fieldset>
          <legend className="text-sm font-medium">Category</legend>
          <label className="block">
            <input type="radio" name="category" value="" defaultChecked={!initial.category} onChange={batchedSubmit} />
            Any
          </label>
          {CATEGORIES.map(c => (
            <label key={c} className="block">
              <input type="radio" name="category" value={c}
                     defaultChecked={initial.category === c}
                     onChange={batchedSubmit} />
              {labelFor(c)} <span className="text-muted-foreground">({facets.categories[c] ?? 0})</span>
            </label>
          ))}
        </fieldset>

        {/* Quality */}
        <fieldset>
          <legend className="text-sm font-medium">Quality</legend>
          <label><input type="radio" name="min_score" value="" defaultChecked={!initial.min_score} onChange={batchedSubmit} />Any</label>
          {SCORE_BUCKETS.map(min => (
            <label key={min} className="block">
              <input type="radio" name="min_score" value={String(min)}
                     defaultChecked={initial.min_score === min}
                     onChange={batchedSubmit} />
              {min}+ stars ({facets.score_buckets[`min_${min}`] ?? 0})
            </label>
          ))}
        </fieldset>

        {/* Vibecoding */}
        <fieldset>
          <legend className="text-sm font-medium">Vibecoding tool</legend>
          <label><input type="radio" name="vibecoding" value="" defaultChecked={!initial.vibecoding} onChange={batchedSubmit} />Any</label>
          {['cursor','bolt','lovable','replit'].map(v => (
            <label key={v} className="block">
              <input type="radio" name="vibecoding" value={v}
                     defaultChecked={initial.vibecoding === v}
                     onChange={batchedSubmit} />
              {v} ({facets.vibecoding[v] ?? 0})
            </label>
          ))}
        </fieldset>

        {/* Feature tags — top-10 + <details> show all (AND semantics, batched debounce) */}
        <fieldset>
          <legend className="text-sm font-medium">Features (AND)</legend>
          {facets.tags.slice(0, 10).map(t => (
            <label key={t.slug} className="block">
              <input type="checkbox" name="tags" value={t.slug}
                     defaultChecked={initial.tags.includes(t.slug)}
                     onChange={batchedSubmit} />
              {t.label} <span className="text-muted-foreground">({t.count})</span>
            </label>
          ))}
          {facets.tags.length > 10 && (
            <details className="mt-2">
              <summary className="cursor-pointer py-2 px-3">Show all ({facets.tags.length - 10})</summary>
              {facets.tags.slice(10).map(t => (
                <label key={t.slug} className="block">
                  <input type="checkbox" name="tags" value={t.slug}
                         defaultChecked={initial.tags.includes(t.slug)}
                         onChange={batchedSubmit} />
                  {t.label} ({t.count})
                </label>
              ))}
            </details>
          )}
        </fieldset>

        <button type="submit" className="hidden">Apply</button>             {/* visible when JS disabled via :only-of-type? No — keep visible always for keyboard ENTER, debounce skips no-op submits */}
      </form>
    </aside>
  );
}
```

`useDebouncedCallback` from a small util in `lib/marketplace/debounce.ts`. Filter sidebar lives OUTSIDE the Suspense boundary so it stays interactive during grid re-render. Use `router.replace({ scroll: false })` if scroll-loss is observed (initial: relying on Next default soft-nav behavior).

### 4.5 ActiveFilterChips

```tsx
// components/marketplace/filter-chips.tsx (CLIENT)
'use client';
const router = useRouter();
const params = useSearchParams();
function removeFilter(key, value?) { /* construct new URLSearchParams without that key/value */ }

return (
  <div className="flex flex-wrap gap-2 mb-4">
    {initial.category && (
      <Chip aria-label={`Remove Category: ${initial.category} filter`}
            onClose={() => removeFilter('category')}>
        Category: {initial.category}
      </Chip>
    )}
    {initial.tags.map(t => (
      <Chip key={t} aria-label={`Remove tag: ${t} filter`}
            onClose={() => removeFilter('tags', t)}>
        {t}
      </Chip>
    ))}
    {/* ... min_score, vibecoding, q ... */}
    {hasAny && (
      <button onClick={() => router.push('/')} className="text-sm underline">Clear all</button>
    )}
  </div>
);
```

### 4.6 Mobile drawer

```tsx
// components/marketplace/filter-drawer.tsx (CLIENT)
// shadcn Sheet wraps FilterSidebar; trigger is sticky button at top of grid on mobile.
<Sheet>
  <SheetTrigger asChild>
    <Button variant="outline" className="lg:hidden sticky top-2 z-10"
            aria-expanded={open ? 'true' : 'false'}>
      <Filter /> Filters {activeCount > 0 && <Badge>{activeCount}</Badge>}
    </Button>
  </SheetTrigger>
  <SheetContent side="bottom" className="h-[80vh]">
    <FilterSidebar initial={initial} facets={facets} />
  </SheetContent>
</Sheet>
```

### 4.7 Sort dropdown

```tsx
// components/marketplace/sort-dropdown.tsx (CLIENT)
<Select name="sort" value={initial.sort} onValueChange={(v) => /* update form */}>
  <SelectItem value="score">Best (quality + stars)</SelectItem>
  <SelectItem value="recent">Recently updated</SelectItem>
  <SelectItem value="popular">Popular (age-normalized)</SelectItem>
  <SelectItem value="reviewed" disabled>
    Most Reviewed <Badge variant="secondary">Coming soon</Badge>
  </SelectItem>
</Select>
```

### 4.8 Pagination

```tsx
// components/marketplace/pagination.tsx (RSC)
<nav aria-label="Pagination" className="flex items-center gap-1">
  {pages.map(p => (
    <Link
      key={p}
      href={hrefForPage(p)}
      prefetch
      aria-label={`Go to page ${p} of ${totalPages}`}
      aria-current={p === currentPage ? 'page' : undefined}
      className={p === currentPage ? 'font-bold' : ''}
    >
      <span className="sr-only">Page </span>{p}
    </Link>
  ))}
</nav>
```

### 4.9 Empty state

```tsx
// components/marketplace/empty-state.tsx (RSC)
<section role="status" aria-labelledby="no-results-heading" className="text-center py-12">
  <h2 id="no-results-heading" className="text-2xl font-semibold">No results found</h2>
  <p className="mt-2 text-muted-foreground">Try clearing some filters, or browse top-rated templates:</p>
  <div className="mt-6">
    <Link href="/" className="text-primary underline">Clear all filters</Link>
  </div>
  <RepoGrid repos={topRated} className="mt-8" />            {/* 4-6 score-DESC fallback */}
</section>
```

### 4.10 Detail page

```tsx
// app/r/[owner]/[name]/page.tsx (RSC)
export async function generateMetadata(props: PageProps<'/r/[owner]/[name]'>) {
  const { owner, name } = await props.params;
  const repo = await getRepo(owner, name);
  if (!repo) return {};                   // not-found.tsx will render via notFound() in Page
  return {
    title: `${owner}/${name} — VibeShelf`,
    description: repo.description?.slice(0, 160),
    openGraph: {
      title: `${owner}/${name}`,
      description: repo.description,
      images: repo.hero_asset?.external_url ? [{ url: repo.hero_asset.external_url }] : [],
    },
  };
}

export default async function Page(props: PageProps<'/r/[owner]/[name]'>) {
  const { owner, name } = await props.params;
  const repo = await getRepo(owner, name);
  if (!repo) notFound();                  // returns 404 status (SEO + crawler signal)
  return (
    <article>
      <RepoHero repo={repo} />
      <ScoreBreakdown axes={repo.scores} />
      <TagsList tags={repo.tags} />
      <ReadmePreview html={await sanitizeReadmeHtml(repo.readme_markdown)} />
      <ForkCtaPlaceholder />
      <ReviewsPlaceholder />
      <JsonLd schema={buildSoftwareApplicationSchema(repo)} />
    </article>
  );
}
```

`getRepo(owner, name)` is the cached function — `'use cache' + cacheTag('repo:${id}')` shared with `generateMetadata` to avoid double-query.

`sanitizeReadmeHtml` uses `isomorphic-dompurify` (works in Node + RSC). Strips `<script>`, absolute-positioned elements, javascript: URLs.

---

## 5. Data layer SQL

### 5.1 Migration: `20260416000001_marketplace_search.sql`

```sql
ALTER TABLE public.repos
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX idx_repos_search_vector_gin
  ON public.repos USING gin (search_vector)
  WHERE status = 'published';
```

### 5.2 List query (two variants — with/without tags)

Reviewer R3 (R1): split into two query variants so the planner picks the partial GIN index cleanly without OR-coalesce on tag arrays.

```typescript
// lib/marketplace/queries.ts (server-only)
import 'server-only';

export async function listRepos(query: MarketplaceQuery): Promise<ListResult> {
  const db = createAnonClient();
  const offset = (query.page - 1) * 36;
  const params = {
    p_q: query.q ?? null,
    p_category: query.category ?? null,
    p_min_score: query.min_score ?? null,
    p_vibecoding: query.vibecoding ?? null,
    p_sort: query.sort,
    p_offset: offset,
    p_tags: query.tags,                               // always [] never null
  };
  const fnName = query.tags.length > 0 ? 'list_repos_with_tags' : 'list_repos_no_tags';
  const { data, error, count } = await db.rpc(fnName, params, { count: 'exact' });
  if (error) throw error;
  return { items: data ?? [], totalCount: count ?? 0 };
}
```

The two RPCs in migration `20260416000002_marketplace_rpcs.sql`:

```sql
-- Both variants share the same SELECT shape via row_type
CREATE TYPE public.marketplace_repo_row AS (
  id uuid, owner text, name text, description text, homepage text, stars int, forks int,
  last_commit_at timestamptz, category public.repo_category, tags_freeform text[],
  total_score numeric(3,2), documentation_score numeric(3,2), maintenance_score numeric(3,2),
  popularity_score numeric(3,2), code_health_score numeric(3,2), visual_preview_score numeric(3,2),
  feature_tags text[], tech_stack_tags text[], vibecoding_tags text[],
  hero_asset jsonb
);

-- Variant A: no tag filter
CREATE OR REPLACE FUNCTION public.list_repos_no_tags(
  p_q text, p_category public.repo_category, p_min_score numeric, p_vibecoding text,
  p_sort text, p_offset int
) RETURNS SETOF public.marketplace_repo_row
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.owner, r.name, r.description, r.homepage, r.stars, r.forks,
    r.last_commit_at, r.category, r.tags_freeform,
    rs.total_score, rs.documentation_score, rs.maintenance_score,
    rs.popularity_score, rs.code_health_score, rs.visual_preview_score,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id=rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind='feature'), ARRAY[]::text[]) AS feature_tags,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id=rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind='tech_stack'), ARRAY[]::text[]) AS tech_stack_tags,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id=rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind='vibecoding_tool'), ARRAY[]::text[]) AS vibecoding_tags,
    asset.hero
  FROM public.repos r
  LEFT JOIN public.repo_scores rs                                            -- LEFT JOIN per Critical R1.C1
    ON rs.repo_id = r.id AND rs.is_latest = true
  LEFT JOIN LATERAL (                                                        -- LATERAL per Real R1.R4
    SELECT jsonb_build_object(                                                -- explicit shape per R1.R5
      'kind', a.kind, 'external_url', a.external_url, 'storage_key', a.storage_key,
      'width', a.width, 'height', a.height, 'priority', a.priority
    ) AS hero
    FROM public.repo_assets a
    WHERE a.repo_id = r.id AND a.kind IN ('readme_gif','readme_image')
    ORDER BY CASE a.kind WHEN 'readme_gif' THEN 0 ELSE 1 END, a.priority ASC
    LIMIT 1
  ) asset ON true
  WHERE r.status = 'published'
    AND rs.id IS NOT NULL                                                    -- enforce "published implies scored"
    AND (p_category IS NULL OR r.category = p_category)
    AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
    AND (p_vibecoding IS NULL OR EXISTS (
      SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id=rt.tag_id
      WHERE rt.repo_id = r.id AND t.kind='vibecoding_tool' AND t.slug = p_vibecoding))
    AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
  ORDER BY
    CASE WHEN p_sort = 'score'  THEN rs.total_score END DESC NULLS LAST,
    CASE WHEN p_sort = 'recent' THEN r.last_commit_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'popular' THEN
      r.stars::numeric / GREATEST(30, EXTRACT(EPOCH FROM (now() - r.github_created_at))/86400)
    END DESC NULLS LAST,
    r.stars DESC                                                             -- tiebreaker
  LIMIT 36 OFFSET p_offset;
END;
$$;

-- Variant B: WITH tag filter (AND semantics)
CREATE OR REPLACE FUNCTION public.list_repos_with_tags(
  p_q text, p_category public.repo_category, p_min_score numeric, p_vibecoding text,
  p_sort text, p_offset int, p_tags text[]
) RETURNS SETOF public.marketplace_repo_row
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  RETURN QUERY
  /* Same SELECT/joins as no_tags variant, plus this extra WHERE: */
  -- AND r.id IN (
  --   SELECT rt2.repo_id FROM public.repo_tags rt2
  --   JOIN public.tags t2 ON t2.id = rt2.tag_id
  --   WHERE t2.slug = ANY(p_tags) AND t2.kind = 'feature'
  --   GROUP BY rt2.repo_id
  --   HAVING count(DISTINCT t2.slug) = array_length(p_tags, 1)
  -- )
  /* (Body identical to list_repos_no_tags except the IN subquery for AND tag matching) */
END;
$$;

REVOKE ALL ON FUNCTION public.list_repos_no_tags(text, public.repo_category, numeric, text, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_no_tags(text, public.repo_category, numeric, text, text, int) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.list_repos_with_tags(text, public.repo_category, numeric, text, text, int, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_with_tags(text, public.repo_category, numeric, text, text, int, text[]) TO anon, authenticated;
```

Granting EXECUTE to `anon` is safe because the functions are STABLE SECURITY INVOKER (run with caller's privileges) and the joined tables enforce RLS for anon visibility.

### 5.3 Facets — UNION ALL pattern

```sql
CREATE OR REPLACE FUNCTION public.get_marketplace_facets() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  result jsonb;
BEGIN
  WITH category_counts AS (
    SELECT 'category' AS facet, category::text AS key, count(*)::int AS cnt
    FROM public.repos WHERE status = 'published' GROUP BY category
  ),
  tag_counts AS (
    SELECT 'tag' AS facet, t.slug AS key, count(DISTINCT r.id)::int AS cnt
    FROM public.tags t
    JOIN public.repo_tags rt ON rt.tag_id = t.id
    JOIN public.repos r ON r.id = rt.repo_id
    WHERE r.status = 'published' AND t.kind = 'feature'
    GROUP BY t.slug
  ),
  vibecoding_counts AS (
    SELECT 'vibecoding' AS facet, t.slug AS key, count(DISTINCT r.id)::int AS cnt
    FROM public.tags t
    JOIN public.repo_tags rt ON rt.tag_id = t.id
    JOIN public.repos r ON r.id = rt.repo_id
    WHERE r.status = 'published' AND t.kind = 'vibecoding_tool'
    GROUP BY t.slug
  ),
  score_buckets AS (
    SELECT 'score_bucket' AS facet,
           bucket AS key,
           count(*)::int AS cnt
    FROM public.repos r
    JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest
    CROSS JOIN LATERAL (VALUES
      ('min_3'::text, rs.total_score >= 3),
      ('min_4'::text, rs.total_score >= 4),
      ('min_4_5'::text, rs.total_score >= 4.5)
    ) AS b(bucket, included)
    WHERE r.status = 'published' AND b.included
    GROUP BY bucket
  ),
  unioned AS (
    SELECT * FROM category_counts UNION ALL
    SELECT * FROM tag_counts UNION ALL
    SELECT * FROM vibecoding_counts UNION ALL
    SELECT * FROM score_buckets
  )
  -- Aggregate UNION ALL rows into nested jsonb: { category: {saas: 47}, tag: {auth: 12, payments: 8}, ... }
  SELECT jsonb_object_agg(facet_grouped.facet, facet_grouped.entries) INTO result
  FROM (
    SELECT facet, jsonb_object_agg(key, cnt) AS entries
    FROM unioned
    GROUP BY facet
  ) facet_grouped;
  RETURN coalesce(result, '{}'::jsonb);
END;
$$;
```

App-side `getMarketplaceFacets()` (`'use cache'`) returns the parsed structure.

### 5.4 Detail query

```sql
-- Single function returning repo + scores + tags + assets + readme content
CREATE OR REPLACE FUNCTION public.get_repo_detail(p_owner text, p_name text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE result jsonb;
BEGIN
  SELECT to_jsonb(r) ||
    jsonb_build_object(
      'scores', to_jsonb(rs),
      'feature_tags',     ...,
      'tech_stack_tags',  ...,
      'vibecoding_tags',  ...,
      'assets', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.priority) FROM public.repo_assets a WHERE a.repo_id = r.id)
    ) INTO result
  FROM public.repos r
  LEFT JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest
  WHERE r.owner = p_owner AND r.name = p_name AND r.status = 'published';
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_repo_detail(text, text) TO anon, authenticated;
```

App: `getRepo(owner, name)` calls RPC; returns null if no row → `notFound()`.

---

## 6. Boundaries + lints

### New dep-cruiser rules

```javascript
// dependency-cruiser.cjs additions
{
  name: "no-marketplace-imports-pipeline",
  severity: "error",
  from: { path: "^lib/marketplace/" },
  to:   { path: "^lib/pipeline/" },
  comment: "marketplace read-side and pipeline write-side share zero code",
},
{
  name: "marketplace-server-only",
  severity: "error",
  from: { path: "^lib/marketplace/(queries|facets)\\." },
  to:   { path: "/node_modules/(react|next/client)/" },
  comment: "queries/facets are server-only — no React/client imports",
},
```

### Negative fixtures

- `lib/marketplace/__fixtures__/bad-pipeline-import.ts` — imports from `lib/pipeline/jobs/echo` (should fail rule 1)
- `lib/marketplace/__fixtures__/bad-react-import-in-queries.ts` — imports `react` (should fail rule 2)

Add to `lint:neg:depcruise` script.

### `import 'server-only'` guards

```typescript
// lib/marketplace/queries.ts (top of file)
import 'server-only';
// lib/marketplace/facets.ts
import 'server-only';
```

### Removing dead code

- `app/page.tsx`: remove `export const dynamic = "force-dynamic"` (Next 16 default; the export is dead)

---

## 7. Testing

### 7.1 Unit (no DB, no network)

```
tests/unit/marketplace/
├── search-params.test.ts            — zod parse: empty, all-set, invalid enum, CSV split
├── score-tier.test.ts               — score 4.7 → "Excellent", boundary tests
├── debounce.test.ts                 — useFakeTimers; rapid calls collapse
└── revalidate-wiring.test.ts        — vi.mock('next/cache'); cron route handler calls revalidateTag with right tags per changedRepoIds
```

### 7.2 Integration (Supabase)

```
tests/integration/marketplace/
├── list-query.test.ts               — variant routing (with/without tags), all filters, sort orderings, AND tag semantics, page offset, search
├── facets.test.ts                   — counts only published, all 4 facet types, 0-result case
├── detail-query.test.ts             — get_repo_detail with valid, invalid, non-published repo
└── search-relevance.test.ts         — tsvector A-weighted name beats B-weighted description
```

### 7.3 E2E (Playwright)

```
tests/e2e/
├── marketplace-desktop.spec.ts      — happy path, filter combinations, pagination
├── marketplace-mobile.spec.ts       — Playwright project: iPhone 13; drawer; touch; smaller pagination
├── marketplace-no-js.spec.ts        — javaScriptEnabled: false; form submit + URL params + SSR list
├── empty-state.spec.ts              — ?q=zzznomatch → empty state + recommendations
├── pagination-overflow.spec.ts      — ?page=9999 → graceful empty / clamp behavior
└── repo-detail.spec.ts              — visit /r/[owner]/[name], score breakdown, JSON-LD presence, og:image meta, fork CTA disabled
```

Playwright `playwright.config.ts` adds `projects` array with desktop + mobile devices.

### 7.4 Dev seed script

```
scripts/seed-dev.ts                  — pnpm seed:dev
```

Contract:
- Refuse to run if `NODE_ENV === 'production'` OR `NEXT_PUBLIC_SUPABASE_URL` not pointing at `127.0.0.1`
- Inserts 30 fixture repos (owner=`fixture-XX`, deterministic IDs) into `repos`, `repo_scores`, `repo_tags`, `repo_assets`
- Idempotent: `ON CONFLICT (github_id) DO UPDATE` so re-runs work
- Prints visit URL when complete

---

## 8. Followups (post-MVP, in scope for #4.5 or later)

1. **Pipeline-side image mirror** (#4.5):
   - Crawl `repo_assets.external_url` → download → upload to Supabase Storage `repo-assets` bucket
   - Probe and store `width/height/content_type` in `repo_assets`
   - Convert GIFs to MP4/WebM (ffmpeg or external service)
   - 404/NSFW health-check → mark assets dead → frontend shows fallback
2. **README full-text search** — add `repos.readme_text_truncated` column populated by ingest, extend `search_vector` formula
3. **Reviewed-rating sort** activated when sub-project #5 ships review data
4. **Q-06 alerting** — first production launch
5. **Admin promotion UI** for `status='scored'` and `'needs_review'` (today: SQL snippets)
6. **Camo URL handling** — once mirror exists, allowlist camo via mirror; until then, drop in extractor

---

## 9. Open questions (deferred)

- **Q-09** (NEW): Image hot-link reliability metric — once SP#4 ships, measure broken-image rate from client analytics. If >5% trigger SP#4.5 sooner.
- **Q-10** (NEW): Internationalization scope — UI strings are English placeholders. Korean translation timing (#5? #6? Pro tier feature?). Tag labels stay English (canonical).

---

## 10. Dev checklist (manual, outside spec)

1. After merge, `pnpm db:types` to refresh `lib/db/database.types.ts` with new RPCs (`list_repos_no_tags`, `list_repos_with_tags`, `get_marketplace_facets`, `get_repo_detail`)
2. Vercel: enable `cacheComponents: true` in next.config; verify build doesn't hang on first deploy
3. Seed dev DB: `pnpm seed:dev` for local visualization
4. Lighthouse audit: aim for Performance ≥80, Accessibility ≥95, SEO ≥95 on `/`

---

## Revision log

- **2026-04-14** — File created during sub-project #4 brainstorming. 4 design sections × 2 reviewers each = 8 reviewer passes applied 18 critical+real findings. User approved all section recommendations.
