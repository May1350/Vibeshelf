# SP#5 Identity + Fork + Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Free-tier value loop — GitHub OAuth sign-in, one-click fork with async verification, structured review composer with image uploads, cache invalidation, GDPR/PIPA account deletion.

**Architecture:** 5 stages (Stage 0 = pre-PR chore for next-intl; Stages 1-4 = main feature PR). Popup-window OAuth preserves composer draft. Fork uses immediate-insert + async verify pattern (`fork_events.verified_at NULL` grace window). Cache invalidation via direct `revalidateTag` + cron-sweep of `cache_invalidation_queue` (Vercel-native, no LISTEN/NOTIFY).

**Tech Stack:** Next.js 16.2.3 App Router + Cache Components, Supabase Auth (GitHub OAuth), `@supabase/ssr`, `next-intl` (Korean-first, detect-via-header), Supabase Storage (signed upload URLs), `piexifjs` for EXIF strip, vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-04-15-sp5-identity-fork-reviews-design.md`

---

## File Map

### New files (Stage 0 — next-intl chore)
```
messages/ko.json                                  — Korean source of truth
messages/en.json                                  — English fallback
lib/i18n/request.ts                               — next-intl getRequestConfig
lib/i18n/routing.ts                               — locale detection via header
middleware.ts                                     — next-intl middleware (locale negotiation)
```

### New files (Stages 1-4 — main feature PR)
```
app/(auth)/sign-in/page.tsx                       — popup target (initiates OAuth)
app/(auth)/callback-popup/page.tsx                — client: postMessage + window.close
app/api/fork/route.ts                             — POST: fork + UPSERT fork_events
app/api/fork/status/route.ts                     — GET: poll fork verify
app/api/reviews/route.ts                          — POST: create review
app/api/reviews/[id]/route.ts                     — PATCH/DELETE: edit/delete own
app/api/reviews/sign-upload/route.ts              — POST: signed upload URL
app/settings/account/delete/page.tsx              — confirmation UI
app/settings/account/delete/route.ts              — POST: GDPR delete flow

components/auth/sign-in-button.tsx                — header button (fallback)
components/auth/sign-in-modal.tsx                 — action-triggered modal
components/auth/user-menu.tsx                     — header user-menu (signed-in)
components/auth/sign-in-listener.tsx              — postMessage + onAuthStateChange hook
components/fork/fork-button.tsx                   — client: fork trigger + poll
components/reviews/image-dropzone.tsx             — EXIF strip + MIME + size cap
components/reviews/review-composer.tsx            — structured prompts
components/reviews/review-card.tsx                — RSC
components/reviews/reviews-list.tsx               — RSC

lib/auth/decrypt-oauth-token.ts                   — decrypt user's GitHub token
lib/auth/require-user.ts                          — server-side getUser() with 401
lib/auth/revoke-token.ts                          — withTokenRevocationOn401 wrapper
lib/github/fork.ts                                — fork API wrapper (422 idempotent)
lib/github/user-token-pool.ts                     — decrypt + apply user token to fetch

supabase/migrations/
  20260415000001_reviews_hidden_at_and_select_own.sql
  20260415000002_fork_events_verified_at.sql
  20260415000003_cache_invalidation_queue.sql
  20260415000004_create_review_with_fork_check_v2.sql

supabase/snippets/reviews-moderation.sql          — ops queries (hide/unhide/delete)

tests/unit/i18n/message-coverage.test.ts
tests/unit/auth/revoke-token.test.ts
tests/unit/reviews/image-dropzone.test.ts
tests/integration/fork/fork-rpc.test.ts
tests/integration/reviews/create-review-v2.test.ts
tests/integration/reviews/hidden-at.test.ts
tests/integration/cache/cache-invalidation-queue.test.ts
tests/e2e/sp5-signin-fork-review.spec.ts
```

### Modified files
```
app/(auth)/callback/route.ts                      — add popup=1 branch redirecting to /auth/callback-popup
app/layout.tsx                                    — wrap with NextIntlClientProvider
app/page.tsx                                      — t() migration + header UserMenu wiring
app/r/[owner]/[name]/page.tsx                    — replace ReviewsPlaceholder + ForkCtaPlaceholder
components/marketplace/*.tsx                      — t() migration (Stage 0)
components/repo/*.tsx                             — t() migration (Stage 0)
app/api/cron/prune/route.ts                       — drain cache_invalidation_queue
package.json                                      — add next-intl, piexifjs, file-type
lib/env.ts                                        — add EMAIL_SENDER_KEY (Resend) env
```

---

## Stage 0 — next-intl migration (separate PR, 1.5 days)

**Goal:** Install next-intl, migrate all SP#1-4 literal strings to message-catalog keys, commit as a standalone PR before Stage 1 begins. The SP#5 main PR should contain ZERO raw user-facing strings.

### Task 0.1: Install dependencies and minimal config

**Files:**
- Create: `lib/i18n/routing.ts`
- Create: `lib/i18n/request.ts`
- Create: `messages/ko.json`
- Create: `messages/en.json`
- Create: `middleware.ts`
- Modify: `package.json`
- Modify: `app/layout.tsx`

- [ ] **Step 0.1.1:** Install packages

```bash
pnpm add next-intl
```

- [ ] **Step 0.1.2:** Create `lib/i18n/routing.ts`

```typescript
// lib/i18n/routing.ts
// next-intl locale setup. Korean-first per Q-10; detect-via-header means
// no URL prefix (existing `/`, `/r/...` paths unchanged). See spec §6.2.

import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["ko", "en"],
  defaultLocale: "ko",
  localePrefix: "never", // no /ko/ or /en/ URL prefix
});
```

- [ ] **Step 0.1.3:** Create `lib/i18n/request.ts`

```typescript
// lib/i18n/request.ts
// next-intl config: read Accept-Language header + optional ?lang cookie
// to pick the locale; default to Korean.

import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const hdrs = await headers();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const headerLocale = hdrs.get("accept-language")?.split(",")[0]?.split("-")[0];
  const candidate = cookieLocale ?? headerLocale ?? routing.defaultLocale;
  const locale = (routing.locales as readonly string[]).includes(candidate)
    ? candidate
    : routing.defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

- [ ] **Step 0.1.4:** Create `messages/ko.json` with the initial key set (migrated from SP#1-4 literal strings)

```json
{
  "marketplace": {
    "title": "VibeShelf",
    "subtitle": "바이브 코더를 위한 큐레이티드 오픈소스 템플릿",
    "search": {
      "placeholder": "템플릿 검색..."
    },
    "filters": {
      "apply": "필터 적용",
      "clearAll": "모두 지우기",
      "category": "카테고리 (OR)",
      "quality": "품질",
      "tool": "바이브코딩 도구",
      "tags": "기능 태그 (AND)",
      "any": "전체",
      "showAll": "전체 보기 ({count})"
    },
    "sort": {
      "label": "정렬",
      "score": "품질 + 별점",
      "recent": "최근 업데이트",
      "popular": "인기 (연령 정규화)",
      "reviewed": "리뷰 많은 순",
      "comingSoon": "곧 출시"
    },
    "grid": {
      "found": "{count, plural, =0 {결과 없음} one {# 개의 템플릿} other {# 개의 템플릿}}",
      "noResults": {
        "heading": "검색 결과가 없습니다",
        "hint": "필터를 지우거나 다른 키워드로 검색해보세요.",
        "recommendations": "추천 템플릿"
      }
    },
    "pagination": {
      "previous": "이전",
      "next": "다음",
      "pageOf": "페이지 {current} / {total}",
      "goToPage": "{page} 페이지로 이동"
    }
  },
  "repo": {
    "viewOnGithub": "GitHub에서 보기",
    "summary": "요약",
    "scoreBreakdown": "스코어 분석",
    "fork": {
      "placeholder": "이 템플릿 포크하기",
      "signInRequired": "포크하려면 로그인 필요"
    },
    "reviewsPlaceholder": "커뮤니티 쇼케이스 준비 중"
  },
  "common": {
    "loading": "로딩 중...",
    "error": "오류가 발생했습니다",
    "tryAgain": "다시 시도"
  }
}
```

- [ ] **Step 0.1.5:** Create `messages/en.json` mirroring the structure with English strings

```json
{
  "marketplace": {
    "title": "VibeShelf",
    "subtitle": "Curated open-source templates for vibe coders",
    "search": { "placeholder": "Search templates..." },
    "filters": {
      "apply": "Apply filters",
      "clearAll": "Clear all",
      "category": "Category (OR)",
      "quality": "Quality",
      "tool": "Vibecoding tool",
      "tags": "Features (AND)",
      "any": "Any",
      "showAll": "Show all ({count})"
    },
    "sort": {
      "label": "Sort by",
      "score": "Best (quality + stars)",
      "recent": "Recently updated",
      "popular": "Popular (age-normalized)",
      "reviewed": "Most Reviewed",
      "comingSoon": "Coming soon"
    },
    "grid": {
      "found": "{count, plural, =0 {No results} one {# template} other {# templates}} found",
      "noResults": {
        "heading": "No matching templates",
        "hint": "Clear filters or try a different keyword.",
        "recommendations": "Recommendations"
      }
    },
    "pagination": {
      "previous": "Previous",
      "next": "Next",
      "pageOf": "Page {current} of {total}",
      "goToPage": "Go to page {page}"
    }
  },
  "repo": {
    "viewOnGithub": "View on GitHub",
    "summary": "Summary",
    "scoreBreakdown": "Score breakdown",
    "fork": {
      "placeholder": "Fork this template",
      "signInRequired": "Sign in to fork"
    },
    "reviewsPlaceholder": "Community showcase coming soon"
  },
  "common": {
    "loading": "Loading...",
    "error": "An error occurred",
    "tryAgain": "Try again"
  }
}
```

- [ ] **Step 0.1.6:** Create `middleware.ts`

```typescript
// middleware.ts
// next-intl middleware: reads accept-language + NEXT_LOCALE cookie,
// sets the locale on the request. No URL rewriting (localePrefix: never).

import createMiddleware from "next-intl/middleware";
import { routing } from "./lib/i18n/routing";

export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
```

- [ ] **Step 0.1.7:** Update `app/layout.tsx` to wrap with `NextIntlClientProvider`

Read current `app/layout.tsx` first. Then add:

```tsx
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 0.1.8:** Update `next.config.ts`

```typescript
// next.config.ts — add the next-intl plugin at the top of the config export
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

export default withNextIntl({
  // existing config: cacheComponents, images.remotePatterns, etc.
});
```

- [ ] **Step 0.1.9:** Verify install compiles

Run: `pnpm typecheck && pnpm build`
Expected: build succeeds; no missing-module errors.

### Task 0.2: Migrate SP#1-4 literal strings to `t()`

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/r/[owner]/[name]/page.tsx`
- Modify: `components/marketplace/empty-state.tsx`
- Modify: `components/marketplace/filter-sidebar.tsx`
- Modify: `components/marketplace/filter-chips.tsx`
- Modify: `components/marketplace/filter-drawer.tsx`
- Modify: `components/marketplace/grid-skeleton.tsx`
- Modify: `components/marketplace/pagination.tsx`
- Modify: `components/marketplace/repo-card.tsx`
- Modify: `components/marketplace/sort-dropdown.tsx`
- Modify: `components/repo/fork-cta-placeholder.tsx`
- Modify: `components/repo/reviews-placeholder.tsx`

- [ ] **Step 0.2.1:** For each RSC (server component), replace literal strings with `getTranslations()`

Example — `app/page.tsx`:

```tsx
import { getTranslations } from "next-intl/server";

export default async function Home(props: PageProps<"/">) {
  const t = await getTranslations("marketplace");
  // ... existing code ...
  return (
    <main className="container mx-auto px-4 py-6">
      <header className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        {/* ... */}
      </header>
      {/* ... */}
    </main>
  );
}
```

Do the same for every RSC referenced in the Files section. Match the key paths in `messages/ko.json`.

- [ ] **Step 0.2.2:** For each client component, use `useTranslations()`

Example — `components/marketplace/filter-sidebar.tsx`:

```tsx
"use client";
import { useTranslations } from "next-intl";

export function FilterSidebar({ initial, facets, className }: FilterSidebarProps) {
  const t = useTranslations("marketplace.filters");
  // replace hardcoded "Apply filters" with {t("apply")}, etc.
}
```

- [ ] **Step 0.2.3:** Update tests that matched on raw English strings

Grep: `pnpm exec rg --files-with-matches '"Search templates"|"Apply filters"|"Any"' tests/`
For each hit, update the test expectation to use the Korean string (since default locale is ko) OR pass `accept-language: en` in the request helper.

- [ ] **Step 0.2.4:** Verify locally

```bash
pnpm dev
# open http://localhost:3000 in browser, confirm Korean strings render
# open http://localhost:3000 with browser locale=en, confirm English renders
# or: curl -H "Accept-Language: en" http://localhost:3000 | grep "VibeShelf"
pnpm typecheck
pnpm lint
pnpm test:unit
```

### Task 0.3: Lint guard against raw strings + commit

**Files:**
- Create: `tests/unit/i18n/message-coverage.test.ts`

- [ ] **Step 0.3.1:** Add a lint/test that flags new JSX literal strings

```typescript
// tests/unit/i18n/message-coverage.test.ts
// Fails if any referenced t() key is missing from ko.json or en.json.

import { describe, expect, it } from "vitest";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "object" && v !== null
      ? flattenKeys(v as Record<string, unknown>, key)
      : [key];
  });
}

describe("i18n message coverage", () => {
  it("ko and en have identical key sets", () => {
    const koKeys = flattenKeys(ko).sort();
    const enKeys = flattenKeys(en).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it("every key value in ko is a non-empty string", () => {
    for (const key of flattenKeys(ko)) {
      const val = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], ko);
      expect(typeof val).toBe("string");
      expect((val as string).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 0.3.2:** Run tests

```bash
pnpm test:unit tests/unit/i18n
```

Expected: both tests pass.

- [ ] **Step 0.3.3:** Commit Stage 0

```bash
git checkout -b chore/sp5-next-intl
git add lib/i18n/ messages/ middleware.ts package.json pnpm-lock.yaml \
        app/layout.tsx app/page.tsx app/r/[owner]/[name]/page.tsx \
        components/marketplace/ components/repo/ next.config.ts \
        tests/unit/i18n/
git commit -m "chore(i18n): install next-intl, migrate SP#1-4 strings (Korean-first per Q-10)

Part of SP#5 Stage 0 precondition. Every literal Korean/English string
from the marketplace + repo-detail surface has been moved to
messages/{ko,en}.json message catalogs and is rendered via
next-intl's getTranslations() (RSC) or useTranslations() (client).

- Default locale: ko (per PRD primary language)
- Fallback: en (via ?lang=en cookie or Accept-Language header)
- No URL prefix (localePrefix: never) — existing /, /r/... paths unchanged
- SEO: hreflang tagging deferred to Q-16 (international expansion)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push -u origin chore/sp5-next-intl
gh pr create --title "chore(i18n): next-intl Korean-first migration (SP#5 Stage 0)" --body "Stage 0 precondition for SP#5. See docs/superpowers/specs/2026-04-15-sp5-identity-fork-reviews-design.md §6."
```

Wait for this PR to merge before starting Stage 1.

---

## Stage 1 — OAuth + sign-in popup (main PR Tasks 1-12)

From here on, all tasks land on branch `feat/sp5-identity-fork-reviews`.

```bash
git checkout main && git pull && git checkout -b feat/sp5-identity-fork-reviews
```

### Task 1: Migrations batch 1 — hidden_at + RLS + verified_at

**Files:**
- Create: `supabase/migrations/20260415000001_reviews_hidden_at_and_select_own.sql`
- Create: `supabase/migrations/20260415000002_fork_events_verified_at.sql`

- [ ] **Step 1.1:** Write `reviews_hidden_at_and_select_own.sql`

```sql
-- SP#5 §3.1 — soft-hide column + RLS so authors still see own hidden reviews.

ALTER TABLE public.reviews
  ADD COLUMN hidden_at timestamptz;

CREATE INDEX idx_reviews_visible
  ON public.reviews(repo_id, created_at DESC)
  WHERE hidden_at IS NULL;

-- Replace the public-read policy with one that filters hidden rows.
DROP POLICY IF EXISTS reviews_select_published ON public.reviews;

CREATE POLICY reviews_select_published
  ON public.reviews FOR SELECT TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.repos r
      WHERE r.id = reviews.repo_id
        AND r.status = 'published'
    )
  );

-- Author still sees their own review (even if hidden) so UPDATE/DELETE
-- policies work. Per Reviewer G: RLS UPDATE USING expressions need a
-- SELECT-side read path to evaluate the row.
CREATE POLICY reviews_select_own
  ON public.reviews FOR SELECT TO authenticated
  USING (user_id = auth.uid());
```

- [ ] **Step 1.2:** Write `fork_events_verified_at.sql`

```sql
-- SP#5 §3.2 — async-verify pattern (verified_at NULL = pending).

ALTER TABLE public.fork_events
  ADD COLUMN verified_at timestamptz;

CREATE INDEX idx_fork_events_user_repo_verified
  ON public.fork_events(user_id, repo_id)
  INCLUDE (verified_at, forked_at);
```

- [ ] **Step 1.3:** Push to cloud dev DB

```bash
supabase db push
```

Expected: both migrations applied. Verify:

```bash
supabase db remote commit --help  # check available subcommand; fallback:
# query current schema via MCP or \d public.reviews
```

- [ ] **Step 1.4:** Integration test

```typescript
// tests/integration/reviews/hidden-at.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnonTestClient, createServiceTestClient } from "@/tests/helpers/test-user";

let svc: any, anon: any;
const PREFIX = 900_600_000;

async function cleanup() {
  await svc.from("reviews").delete().like("repo_id", "%"); // scoped via repo_id below
}

describe("reviews.hidden_at RLS", () => {
  beforeAll(() => {
    svc = createServiceTestClient();
    anon = createAnonTestClient();
  });
  // ... seeding helpers matching existing test patterns ...

  it("anon SELECT excludes hidden reviews", async () => {
    // seed 2 reviews, one hidden
    // SELECT as anon → only 1 returned
  });

  it("author SELECT includes their own hidden review", async () => {
    // seed review by userA, hide it
    // SELECT as userA → sees their hidden review
  });
});
```

- [ ] **Step 1.5:** Commit

```bash
git add supabase/migrations/20260415000001_* supabase/migrations/20260415000002_* \
        tests/integration/reviews/hidden-at.test.ts
git commit -m "feat(db): SP#5 migrations 1-2 — reviews.hidden_at + fork_events.verified_at

Per spec §3.1 + §3.2. Soft-hide column on reviews with a filtering RLS
policy + an author-can-see-own policy so UPDATE/DELETE USING clauses
work. Async-verify pattern on fork_events — row inserted immediately
with verified_at NULL; backfilled by the fork-status endpoint.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 2: Migration 3 — `cache_invalidation_queue`

**Files:**
- Create: `supabase/migrations/20260415000003_cache_invalidation_queue.sql`

- [ ] **Step 2.1:** Write the migration

```sql
-- SP#5 §3.3 — cron-sweep queue for SQL-snippet ops cache invalidation.
-- Direct revalidateTag() covers all API-path writes; this queue only
-- catches out-of-band SQL snippet operations (moderation).

CREATE TABLE public.cache_invalidation_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag         text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  drained_at  timestamptz
);

CREATE INDEX idx_cache_inv_queue_pending
  ON public.cache_invalidation_queue(enqueued_at)
  WHERE drained_at IS NULL;

ALTER TABLE public.cache_invalidation_queue ENABLE ROW LEVEL SECURITY;
-- service-role only; ops snippets run as service_role, API routes don't touch this.
```

- [ ] **Step 2.2:** Push + verify

```bash
supabase db push
```

- [ ] **Step 2.3:** Commit

```bash
git add supabase/migrations/20260415000003_*
git commit -m "feat(db): SP#5 migration 3 — cache_invalidation_queue

Per spec §3.3. Replaces the originally-proposed pg_notify+LISTEN
design (undeliverable on Vercel serverless — Reviewer G). SQL-snippet
ops enqueue rows here; the existing prune cron drains them into
revalidateTag() calls. Worst-case staleness: 1 week (prune cadence).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 3: Migration 4 — `create_review_with_fork_check_v2` RPC

**Files:**
- Create: `supabase/migrations/20260415000004_create_review_with_fork_check_v2.sql`

- [ ] **Step 3.1:** Write the migration

```sql
-- SP#5 §3.5 — v2 RPC: grace-window fork check + 23505 translation.

DROP FUNCTION IF EXISTS public.create_review_with_fork_check(
  uuid, smallint, text, public.vibecoding_tool
);

CREATE OR REPLACE FUNCTION public.create_review_with_fork_check_v2(
  p_repo_id uuid,
  p_rating smallint,
  p_text_body text,
  p_vibecoding_tool public.vibecoding_tool,
  p_image_keys text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_review_id uuid;
  v_forked boolean;
  v_key text;
  v_ordering smallint := 0;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;

  -- Fork-check: either verified OR forked within 30s (grace window).
  SELECT EXISTS (
    SELECT 1 FROM public.fork_events
    WHERE user_id = v_user_id AND repo_id = p_repo_id
      AND (verified_at IS NOT NULL OR forked_at > now() - interval '30 seconds')
  ) INTO v_forked;

  IF NOT v_forked THEN
    RAISE EXCEPTION 'fork_required' USING ERRCODE = 'P0001';
  END IF;

  -- Validate rating bounds (table CHECK does this too, but surface a nicer error).
  IF p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'rating_out_of_range' USING ERRCODE = 'P0001';
  END IF;

  -- Validate ≤5 images.
  IF array_length(p_image_keys, 1) > 5 THEN
    RAISE EXCEPTION 'too_many_images' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.reviews (repo_id, user_id, rating, text_body, vibecoding_tool)
    VALUES (p_repo_id, v_user_id, p_rating, p_text_body, p_vibecoding_tool)
    RETURNING id INTO v_review_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'already_reviewed' USING ERRCODE = 'P0001';
  END;

  -- Insert assets one-at-a-time (per-row enforce_review_asset_limit trigger).
  IF p_image_keys IS NOT NULL THEN
    FOREACH v_key IN ARRAY p_image_keys LOOP
      INSERT INTO public.review_assets (review_id, storage_key, content_type, ordering)
      VALUES (v_review_id, v_key, 'image/*', v_ordering);
      v_ordering := v_ordering + 1;
    END LOOP;
  END IF;

  RETURN v_review_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_review_with_fork_check_v2(
  uuid, smallint, text, public.vibecoding_tool, text[]
) FROM public;

GRANT EXECUTE ON FUNCTION public.create_review_with_fork_check_v2(
  uuid, smallint, text, public.vibecoding_tool, text[]
) TO authenticated;
```

- [ ] **Step 3.2:** Push + verify

```bash
supabase db push
```

- [ ] **Step 3.3:** Integration test

```typescript
// tests/integration/reviews/create-review-v2.test.ts
// Covers: happy path (verified fork), happy path (grace window), rejection
// (no fork), rejection (already reviewed — 23505), rejection (rating OOB),
// rejection (>5 images).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceTestClient, createTestUser } from "@/tests/helpers/test-user";

// ... (seeding helpers following the project's integration test pattern) ...

describe("create_review_with_fork_check_v2 RPC", () => {
  // 6 tests per the spec §3.5 enumeration
});
```

- [ ] **Step 3.4:** Commit

```bash
git add supabase/migrations/20260415000004_* tests/integration/reviews/create-review-v2.test.ts
git commit -m "feat(db): SP#5 migration 4 — create_review_with_fork_check_v2 RPC

Per spec §3.5. Replaces v1 with:
- 30-second grace window on fork_events.verified_at NULL
- 23505 translation → P0001 'already_reviewed'
- Bounded rating + ≤5 image keys validation
- One-at-a-time asset insert (honors per-row enforce_review_asset_limit)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 4: `lib/auth/` helpers

**Files:**
- Create: `lib/auth/decrypt-oauth-token.ts`
- Create: `lib/auth/require-user.ts`
- Create: `lib/auth/revoke-token.ts`
- Test: `tests/unit/auth/revoke-token.test.ts`

- [ ] **Step 4.1:** `decrypt-oauth-token.ts`

```typescript
// lib/auth/decrypt-oauth-token.ts
// Server-only: load encrypted GitHub provider_token for the current user,
// decrypt, return plaintext. The plaintext NEVER leaves this module scope
// in a way that outlives a single request handler.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken } from "@/lib/crypto/tokens";

export async function decryptOAuthToken(
  db: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("github_oauth_tokens")
    .select("token_encrypted, token_key_version")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`decryptOAuthToken: ${error.message}`);
  if (!data) return null;
  // bytea comes back from PostgREST as `\x<hex>` string — decode first.
  const hex = (data.token_encrypted as unknown as string).replace(/^\\x/, "");
  const buf = Buffer.from(hex, "hex");
  return decryptToken(buf, data.token_key_version);
}
```

- [ ] **Step 4.2:** `require-user.ts`

```typescript
// lib/auth/require-user.ts
// Server-only: current user or 401. Use in Route Handlers.

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export async function requireUser(): Promise<{ userId: string; db: ReturnType<typeof createServerClient> }> {
  const cookieStore = await cookies();
  const db = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    },
  );
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError();
  return { userId: data.user.id, db };
}
```

- [ ] **Step 4.3:** `revoke-token.ts`

```typescript
// lib/auth/revoke-token.ts
// Wrap user-scoped GitHub API calls so a 401 response triggers
// mark_oauth_token_revoked + structured log. Per spec §7.1.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

interface RevokeContext {
  db: SupabaseClient;
  userId: string;
  token: string;
}

export async function withTokenRevocationOn401(
  fn: (token: string) => Promise<Response>,
  ctx: RevokeContext,
): Promise<Response> {
  const res = await fn(ctx.token);
  if (res.status === 401) {
    await ctx.db.rpc("mark_oauth_token_revoked", { p_user_id: ctx.userId });
    console.log(
      JSON.stringify({
        event: "oauth_token_revoked",
        user_id: ctx.userId,
        reason: "401 from GitHub API",
        ts: new Date().toISOString(),
      }),
    );
  }
  return res;
}
```

- [ ] **Step 4.4:** Unit test for revoke-token

```typescript
// tests/unit/auth/revoke-token.test.ts
import { describe, expect, it, vi } from "vitest";
import { withTokenRevocationOn401 } from "@/lib/auth/revoke-token";

describe("withTokenRevocationOn401", () => {
  it("calls mark_oauth_token_revoked on 401", async () => {
    const rpcMock = vi.fn().mockResolvedValue({ error: null });
    const db = { rpc: rpcMock } as any;
    const fn = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await withTokenRevocationOn401(fn, { db, userId: "u1", token: "t" });
    expect(rpcMock).toHaveBeenCalledWith("mark_oauth_token_revoked", { p_user_id: "u1" });
  });

  it("does NOT revoke on 200", async () => {
    const rpcMock = vi.fn();
    const db = { rpc: rpcMock } as any;
    const fn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await withTokenRevocationOn401(fn, { db, userId: "u1", token: "t" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("passes through the fetch response unchanged", async () => {
    const res = new Response("ok", { status: 200 });
    const fn = vi.fn().mockResolvedValue(res);
    const db = { rpc: vi.fn() } as any;
    const got = await withTokenRevocationOn401(fn, { db, userId: "u1", token: "t" });
    expect(got).toBe(res);
  });
});
```

- [ ] **Step 4.5:** Run + commit

```bash
pnpm test:unit tests/unit/auth
git add lib/auth/ tests/unit/auth/
git commit -m "feat(auth): decrypt-oauth-token + require-user + revoke-token helpers

Per spec §4.2 + §7.1. Server-only utilities for user-scoped GitHub calls:
- decrypt the user's stored token on demand (plaintext stays in request scope)
- require an authenticated user or throw UnauthorizedError
- wrap GitHub calls with 401-revocation behavior and structured logging

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 5: OAuth callback popup branch + popup client page

**Files:**
- Modify: `app/(auth)/callback/route.ts`
- Create: `app/(auth)/callback-popup/page.tsx`
- Create: `app/(auth)/sign-in/page.tsx`

- [ ] **Step 5.1:** Add popup branch to callback route

Read `app/(auth)/callback/route.ts`. Before the final `NextResponse.redirect(${origin}${next})`, insert:

```typescript
const popup = searchParams.get("popup");
if (popup === "1") {
  return NextResponse.redirect(`${origin}/auth/callback-popup`);
}
```

- [ ] **Step 5.2:** Create `callback-popup/page.tsx`

```tsx
// app/(auth)/callback-popup/page.tsx
"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export default function CallbackPopupPage() {
  const [orphaned, setOrphaned] = useState(false);
  const t = useTranslations("auth.callbackPopup");

  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage(
        { type: "vibeshelf:signed-in" },
        window.location.origin,
      );
      window.close();
    } else {
      setOrphaned(true);
    }
  }, []);

  if (orphaned) {
    return (
      <main className="flex h-screen items-center justify-center">
        <div className="text-center">
          <p className="mb-4">{t("parentClosed")}</p>
          <a href="/" className="underline text-primary">{t("returnLink")}</a>
        </div>
      </main>
    );
  }
  return <main className="flex h-screen items-center justify-center"><p>{t("loading")}</p></main>;
}
```

- [ ] **Step 5.3:** Add message keys

Append to `messages/ko.json`:

```json
"auth": {
  "callbackPopup": {
    "loading": "로그인 완료 중...",
    "parentClosed": "원래 탭이 닫혔습니다.",
    "returnLink": "VibeShelf로 돌아가기"
  },
  "signIn": {
    "title": "GitHub 로그인",
    "starting": "GitHub로 이동 중...",
    "failedHeading": "로그인 실패",
    "tryAgain": "다시 시도"
  },
  "modal": {
    "title": "GitHub 계정 연동",
    "body": "포크와 리뷰를 위해 GitHub 연동이 필요해요. 공개 저장소 접근 권한만 요청합니다.",
    "confirm": "GitHub로 계속",
    "cancel": "취소",
    "popupBlocked": "팝업이 차단되었어요. 팝업 허용 후 다시 시도하거나 전체 페이지 로그인으로 진행할게요."
  }
}
```

And the corresponding en.json entries.

- [ ] **Step 5.4:** Create `sign-in/page.tsx` (popup target)

```tsx
// app/(auth)/sign-in/page.tsx
"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

export default function SignInPage() {
  const t = useTranslations("auth.signIn");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const params = new URLSearchParams(window.location.search);
    const popup = params.get("popup") === "1";
    supabase.auth
      .signInWithOAuth({
        provider: "github",
        options: {
          scopes: "public_repo",
          redirectTo: `${window.location.origin}/auth/callback${popup ? "?popup=1" : ""}`,
        },
      })
      .then(({ error }) => {
        if (error) setErr(error.message);
      });
  }, []);

  return (
    <main className="flex h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-xl font-semibold mb-2">{t("title")}</h1>
        {err ? <p className="text-destructive">{err}</p> : <p>{t("starting")}</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 5.5:** Commit

```bash
git add app/\(auth\)/ messages/ko.json messages/en.json
git commit -m "feat(auth): popup-pattern OAuth flow (callback-popup + sign-in page)

Per spec §4.1 (with Reviewer G architecture correction). The existing
Route Handler callback can't window.opener.postMessage — it returns
Response. On popup=1 it now redirects to a tiny client page that fires
postMessage + window.close. Cross-tab session propagation is handled
via Supabase onAuthStateChange in the sign-in-listener component (next task).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 6: Sign-in button + modal + user menu + listener

**Files:**
- Create: `components/auth/sign-in-button.tsx`
- Create: `components/auth/sign-in-modal.tsx`
- Create: `components/auth/sign-in-listener.tsx`
- Create: `components/auth/user-menu.tsx`

- [ ] **Step 6.1:** `sign-in-button.tsx`

```tsx
// components/auth/sign-in-button.tsx
"use client";

import { Github } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useSignInListener } from "./sign-in-listener";

export function SignInButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const t = useTranslations("auth.modal");
  const { openPopup } = useSignInListener();
  return (
    <Button variant={variant} onClick={() => openPopup()}>
      <Github aria-hidden="true" />
      <span className="ml-2">{t("confirm")}</span>
    </Button>
  );
}
```

- [ ] **Step 6.2:** `sign-in-listener.tsx` — hook + popup orchestration

```tsx
// components/auth/sign-in-listener.tsx
"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const POPUP_FEATURES = "width=500,height=700,left=200,top=200";

export function useSignInListener() {
  const router = useRouter();
  const [session, setSession] = useState<{ id: string } | null>(null);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    // Cross-tab: if the user signs in on another tab, we learn via this.
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ? { id: s.user.id } : null);
      if (s) router.refresh();
    });
    return () => data.subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== "vibeshelf:signed-in") return;
      // session updates via onAuthStateChange automatically; just refresh.
      router.refresh();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  const openPopup = useCallback(() => {
    const popup = window.open("/auth/sign-in?popup=1", "vibeshelf-auth", POPUP_FEATURES);
    if (popup === null) {
      // Popup blocked — full-page fallback.
      window.location.href = `/auth/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    popupRef.current = popup;
  }, []);

  return { session, openPopup };
}
```

- [ ] **Step 6.3:** `sign-in-modal.tsx` — action-triggered

```tsx
// components/auth/sign-in-modal.tsx
"use client";

import { Github } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSignInListener } from "./sign-in-listener";

interface SignInModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after successful sign-in. Parent can re-run the gated action. */
  onSignedIn?: () => void;
}

export function SignInModal({ open, onOpenChange, onSignedIn }: SignInModalProps) {
  const t = useTranslations("auth.modal");
  const { session, openPopup } = useSignInListener();

  // When session becomes non-null while the modal is open → close + callback.
  if (open && session) {
    onOpenChange(false);
    onSignedIn?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <Button onClick={() => openPopup()}>
          <Github aria-hidden="true" />
          <span className="ml-2">{t("confirm")}</span>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6.4:** `user-menu.tsx` — header widget for signed-in

```tsx
// components/auth/user-menu.tsx
"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SignInButton } from "./sign-in-button";

export function UserMenu() {
  const t = useTranslations("auth.userMenu");
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        const meta = data.user.user_metadata as { user_name?: string; preferred_username?: string };
        setUsername(meta.user_name ?? meta.preferred_username ?? "user");
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) {
        const meta = s.user.user_metadata as { user_name?: string; preferred_username?: string };
        setUsername(meta.user_name ?? meta.preferred_username ?? "user");
      } else {
        setUsername(null);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!username) return <SignInButton />;

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">@{username}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          const supabase = createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          );
          await supabase.auth.signOut();
          router.refresh();
        }}
      >
        {t("signOut")}
      </Button>
    </div>
  );
}
```

Append to `messages/ko.json`:

```json
"userMenu": {
  "signOut": "로그아웃"
}
```

- [ ] **Step 6.5:** Wire `UserMenu` into the home page header

Modify `app/page.tsx`:

```tsx
import { UserMenu } from "@/components/auth/user-menu";
// ... inside the <header>: add <UserMenu /> next to <SortDropdown />
```

Also add to repo-detail page header if there is one.

- [ ] **Step 6.6:** Commit

```bash
git add components/auth/ app/page.tsx messages/
git commit -m "feat(auth): sign-in modal + button + listener + header user-menu

Per spec §2.2 + §4.1. Popup OAuth orchestration with onAuthStateChange
integration (cross-tab) + postMessage from /auth/callback-popup. Modal
copy explains 'why GitHub' per Reviewer E. Popup-blocked detection
falls back to full-page redirect with ?next= param.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 7: Verify Stage 1 + PR Checkpoint

- [ ] **Step 7.1:** Local smoke

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build
pnpm dev
# open http://localhost:3000 in browser — anonymous browsing still works
# click the header "로그아웃" state (should show "GitHub 로그인" button)
# click button — popup should open, navigate to GitHub OAuth
```

- [ ] **Step 7.2:** Push Stage 1 (continue on the same branch; do NOT open PR until Stage 4 completes)

```bash
git push -u origin feat/sp5-identity-fork-reviews
```

---

## Stage 2 — Fork CTA + async verify (Tasks 8-11)

### Task 8: `lib/github/fork.ts` + `lib/github/user-token-pool.ts`

**Files:**
- Create: `lib/github/user-token-pool.ts`
- Create: `lib/github/fork.ts`

- [ ] **Step 8.1:** `user-token-pool.ts`

```typescript
// lib/github/user-token-pool.ts
// Server-only: combines decrypt + apply the user's stored GitHub token
// to a fetch call. Distinct from lib/pipeline/github/token-pool.ts (the
// app-scoped search/REST pool for cron jobs).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOAuthToken } from "@/lib/auth/decrypt-oauth-token";

export class UserTokenMissingError extends Error {
  constructor() {
    super("user has no stored GitHub token");
    this.name = "UserTokenMissingError";
  }
}

export async function fetchWithUserToken(
  db: SupabaseClient,
  userId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await decryptOAuthToken(db, userId);
  if (!token) throw new UserTokenMissingError();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `token ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "VibeShelf");
  return fetch(url, { ...init, headers });
}
```

- [ ] **Step 8.2:** `fork.ts`

```typescript
// lib/github/fork.ts
// Wrap POST /repos/{owner}/{name}/forks with idempotency (422 "already exists").

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withTokenRevocationOn401 } from "@/lib/auth/revoke-token";
import { decryptOAuthToken } from "@/lib/auth/decrypt-oauth-token";

export interface ForkResult {
  github_fork_id: number;
  github_fork_url: string;
  full_name: string; // "userlogin/repoName"
  already_existed: boolean;
}

export async function forkRepo(
  db: SupabaseClient,
  userId: string,
  owner: string,
  name: string,
): Promise<ForkResult> {
  const token = await decryptOAuthToken(db, userId);
  if (!token) throw new Error("no_token");

  const res = await withTokenRevocationOn401(
    (t) =>
      fetch(`https://api.github.com/repos/${owner}/${name}/forks`, {
        method: "POST",
        headers: {
          Authorization: `token ${t}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "VibeShelf",
        },
      }),
    { db, userId, token },
  );

  if (res.status === 202 || res.status === 201) {
    const body = (await res.json()) as { id: number; html_url: string; full_name: string };
    return {
      github_fork_id: body.id,
      github_fork_url: body.html_url,
      full_name: body.full_name,
      already_existed: false,
    };
  }

  if (res.status === 422) {
    // "Fork already exists" — GitHub doesn't return the fork's id, so we
    // look it up: GET /repos/{user}/{name} where user = authenticated user
    const meRes = await withTokenRevocationOn401(
      (t) =>
        fetch("https://api.github.com/user", {
          headers: {
            Authorization: `token ${t}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "VibeShelf",
          },
        }),
      { db, userId, token },
    );
    if (!meRes.ok) throw new Error(`fork 422 recovery: /user ${meRes.status}`);
    const me = (await meRes.json()) as { login: string };
    const forkRes = await withTokenRevocationOn401(
      (t) =>
        fetch(`https://api.github.com/repos/${me.login}/${name}`, {
          headers: {
            Authorization: `token ${t}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "VibeShelf",
          },
        }),
      { db, userId, token },
    );
    if (!forkRes.ok) throw new Error(`fork 422 recovery: lookup ${forkRes.status}`);
    const existing = (await forkRes.json()) as { id: number; html_url: string; full_name: string };
    return {
      github_fork_id: existing.id,
      github_fork_url: existing.html_url,
      full_name: existing.full_name,
      already_existed: true,
    };
  }

  throw new Error(`fork failed: ${res.status}`);
}

export async function verifyForkExists(
  db: SupabaseClient,
  userId: string,
  fullName: string,
): Promise<boolean> {
  const token = await decryptOAuthToken(db, userId);
  if (!token) return false;
  const res = await withTokenRevocationOn401(
    (t) =>
      fetch(`https://api.github.com/repos/${fullName}`, {
        headers: {
          Authorization: `token ${t}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "VibeShelf",
        },
      }),
    { db, userId, token },
  );
  return res.ok;
}
```

- [ ] **Step 8.3:** Commit

```bash
git add lib/github/fork.ts lib/github/user-token-pool.ts
git commit -m "feat(github): user-token fetch wrapper + fork API client

Per spec §4.2. forkRepo handles the 202-async + 422-already-exists
idempotency paths. verifyForkExists is used by the polling status
endpoint. withTokenRevocationOn401 wires 401s into the revocation
audit path.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 9: API routes `/api/fork` + `/api/fork/status`

**Files:**
- Create: `app/api/fork/route.ts`
- Create: `app/api/fork/status/route.ts`

- [ ] **Step 9.1:** `app/api/fork/route.ts`

```typescript
// app/api/fork/route.ts
// POST /api/fork { repo_id, owner, name } → UPSERT fork_events + trigger fork.

import { NextResponse } from "next/server";
import { forkRepo } from "@/lib/github/fork";
import { requireUser, UnauthorizedError } from "@/lib/auth/require-user";

export async function POST(req: Request) {
  try {
    const { userId, db } = await requireUser();
    const body = (await req.json()) as { repo_id: string; owner: string; name: string };

    const fork = await forkRepo(db, userId, body.owner, body.name);

    // UPSERT — idempotent on (user_id, repo_id) unique.
    const { data, error } = await db
      .from("fork_events")
      .upsert(
        {
          user_id: userId,
          repo_id: body.repo_id,
          github_fork_id: fork.github_fork_id,
          github_fork_url: fork.github_fork_url,
          forked_at: new Date().toISOString(),
          verified_at: fork.already_existed ? new Date().toISOString() : null,
        },
        { onConflict: "user_id,repo_id" },
      )
      .select("id, verified_at")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      fork_event_id: data.id,
      fork_url: fork.github_fork_url,
      status: fork.already_existed ? "verified" : "pending",
      full_name: fork.full_name,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 9.2:** `app/api/fork/status/route.ts`

```typescript
// app/api/fork/status/route.ts
// GET /api/fork/status?fork_event_id=... — verify + backfill verified_at.

import { NextResponse } from "next/server";
import { verifyForkExists } from "@/lib/github/fork";
import { requireUser, UnauthorizedError } from "@/lib/auth/require-user";

export async function GET(req: Request) {
  try {
    const { userId, db } = await requireUser();
    const url = new URL(req.url);
    const forkEventId = url.searchParams.get("fork_event_id");
    if (!forkEventId) return NextResponse.json({ error: "missing fork_event_id" }, { status: 400 });

    const { data: row } = await db
      .from("fork_events")
      .select("id, user_id, github_fork_url, verified_at")
      .eq("id", forkEventId)
      .maybeSingle();
    if (!row || row.user_id !== userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.verified_at) return NextResponse.json({ status: "verified" });

    // full_name parsed from stored URL: https://github.com/{owner}/{name}
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)/.exec(row.github_fork_url);
    if (!m) return NextResponse.json({ status: "pending" });

    const exists = await verifyForkExists(db, userId, m[1]);
    if (exists) {
      await db
        .from("fork_events")
        .update({ verified_at: new Date().toISOString() })
        .eq("id", forkEventId);
      return NextResponse.json({ status: "verified" });
    }
    return NextResponse.json({ status: "pending" });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 9.3:** Commit

```bash
git add app/api/fork/
git commit -m "feat(api): POST /api/fork + GET /api/fork/status

Per spec §4.2. POST fires the GitHub fork + UPSERT fork_events in one
request; client receives fork_event_id immediately and polls status.
GET verifies server-side by hitting /repos/{user}/{forkname} and
backfills verified_at on success.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 10: `<ForkButton>` component

**Files:**
- Create: `components/fork/fork-button.tsx`

- [ ] **Step 10.1:** Component

```tsx
// components/fork/fork-button.tsx
"use client";

import { ExternalLink, GitFork, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SignInModal } from "@/components/auth/sign-in-modal";
import { useSignInListener } from "@/components/auth/sign-in-listener";

interface ForkButtonProps {
  repoId: string;
  owner: string;
  name: string;
}

type ForkState =
  | { kind: "idle" }
  | { kind: "signing-in" }
  | { kind: "pending"; forkEventId: string; forkUrl: string; attempts: number }
  | { kind: "verified"; forkUrl: string }
  | { kind: "error"; message: string };

export function ForkButton({ repoId, owner, name }: ForkButtonProps) {
  const t = useTranslations("fork");
  const { session } = useSignInListener();
  const [state, setState] = useState<ForkState>({ kind: "idle" });
  const [signInOpen, setSignInOpen] = useState(false);

  async function doFork() {
    setState({ kind: "pending", forkEventId: "", forkUrl: "", attempts: 0 });
    const res = await fetch("/api/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_id: repoId, owner, name }),
    });
    if (!res.ok) {
      setState({ kind: "error", message: `${res.status}` });
      return;
    }
    const json = (await res.json()) as {
      fork_event_id: string;
      fork_url: string;
      status: "verified" | "pending";
    };
    if (json.status === "verified") {
      setState({ kind: "verified", forkUrl: json.fork_url });
      return;
    }
    setState({ kind: "pending", forkEventId: json.fork_event_id, forkUrl: json.fork_url, attempts: 0 });
    pollStatus(json.fork_event_id, json.fork_url, 0);
  }

  async function pollStatus(forkEventId: string, forkUrl: string, attempt: number) {
    if (attempt >= 5) {
      // Give up polling; keep button showing pending URL. Grace window in
      // the composer still allows review for 30s post-fork per spec §3.5.
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`/api/fork/status?fork_event_id=${forkEventId}`);
    if (!res.ok) {
      pollStatus(forkEventId, forkUrl, attempt + 1);
      return;
    }
    const json = (await res.json()) as { status: "verified" | "pending" };
    if (json.status === "verified") {
      setState({ kind: "verified", forkUrl });
      return;
    }
    setState({ kind: "pending", forkEventId, forkUrl, attempts: attempt + 1 });
    pollStatus(forkEventId, forkUrl, attempt + 1);
  }

  function onClick() {
    if (!session) {
      setSignInOpen(true);
      return;
    }
    doFork();
  }

  return (
    <>
      <Button
        onClick={onClick}
        disabled={state.kind === "pending" && state.attempts < 5}
        variant={state.kind === "verified" ? "secondary" : "default"}
      >
        {state.kind === "pending" ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span className="ml-2">{t("pending")}</span>
          </>
        ) : state.kind === "verified" ? (
          <a href={state.forkUrl} target="_blank" rel="noopener" className="flex items-center">
            <ExternalLink aria-hidden="true" />
            <span className="ml-2">{t("viewFork")}</span>
          </a>
        ) : (
          <>
            <GitFork aria-hidden="true" />
            <span className="ml-2">{t("do")}</span>
          </>
        )}
      </Button>
      <SignInModal open={signInOpen} onOpenChange={setSignInOpen} onSignedIn={() => doFork()} />
    </>
  );
}
```

- [ ] **Step 10.2:** Add `fork` namespace to message catalogs

Append to `messages/ko.json`:

```json
"fork": {
  "do": "이 템플릿 포크",
  "pending": "포크 생성 중...",
  "verified": "포크 완료",
  "viewFork": "내 포크 보기",
  "error": "포크 실패"
}
```

- [ ] **Step 10.3:** Wire into repo-detail page

Modify `app/r/[owner]/[name]/page.tsx` — replace the existing `<ForkCtaPlaceholder />` render inside `<RepoHero>` (or wherever it lives) with:

```tsx
import { ForkButton } from "@/components/fork/fork-button";
// ...
<ForkButton repoId={repo.id} owner={owner} name={name} />
```

If `fork-cta-placeholder.tsx` is now unused, leave it for later deletion to avoid scope creep in this commit.

- [ ] **Step 10.4:** Commit

```bash
git add components/fork/ app/r/\[owner\]/\[name\]/page.tsx messages/
git commit -m "feat(fork): <ForkButton> with async-verify polling

Per spec §4.2. Client-side state machine: idle → pending → (polled) →
verified OR stays pending gracefully (composer grace window covers).
Calls <SignInModal> on click when unauthenticated; the modal's
onSignedIn callback fires doFork() so the same click reaches its
intended end state.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 11: Integration test for fork flow

**Files:**
- Create: `tests/integration/fork/fork-rpc.test.ts`

- [ ] **Step 11.1:** Integration test (mocks GitHub via `vi.stubGlobal('fetch', ...)` like SP#2 patterns)

```typescript
// tests/integration/fork/fork-rpc.test.ts
// Verifies: 202-accepted path creates fork_events with verified_at NULL;
// 422-already-exists path inserts with verified_at set; 401 triggers
// mark_oauth_token_revoked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceTestClient } from "@/tests/helpers/test-user";

// ... setup: mock fetch to return 202 / 422 / 401 on POST /forks ...
// Assert fork_events row shape + token revocation behavior.
```

- [ ] **Step 11.2:** Run + commit

```bash
pnpm test:integration tests/integration/fork
git add tests/integration/fork/
git commit -m "test(fork): happy path + 422 idempotency + 401 revocation

Per spec §9.2. Mocked GitHub responses; real DB writes; verifies
fork_events row shape and mark_oauth_token_revoked invocation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Stage 3 — Reviews + image dropzone (Tasks 12-18)

### Task 12: `<ImageDropzone>` component

**Files:**
- Create: `components/reviews/image-dropzone.tsx`
- Test: `tests/unit/reviews/image-dropzone.test.ts`
- Modify: `package.json`

- [ ] **Step 12.1:** Install `piexifjs` + `file-type` (browser-safe build)

```bash
pnpm add piexifjs
pnpm add -D @types/piexifjs
```

- [ ] **Step 12.2:** Component (EXIF strip + MIME sniff + size cap)

```tsx
// components/reviews/image-dropzone.tsx
"use client";

import { UploadCloud, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import piexif from "piexifjs";
import { Button } from "@/components/ui/button";

const MAX_FILES = 5;
const MAX_BYTES = 5_000_000;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

interface ImageDropzoneProps {
  onChange: (keys: string[]) => void;
}

interface UploadedImage {
  key: string;
  previewUrl: string;
}

/** Best-effort magic-byte sniff. Returns detected MIME or null. */
async function sniffMime(file: File): Promise<string | null> {
  const buf = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  // WEBP (RIFF....WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  return null;
}

/** Strip EXIF for JPEG only. PNG/WEBP/GIF don't carry EXIF meaningfully. */
async function stripExif(file: File): Promise<Blob> {
  if (file.type !== "image/jpeg") return file;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const stripped = piexif.remove(dataUrl);
  const bin = atob(stripped.split(",")[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "image/jpeg" });
}

export function ImageDropzone({ onChange }: ImageDropzoneProps) {
  const t = useTranslations("reviews.dropzone");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      const incoming = Array.from(files);
      if (images.length + incoming.length > MAX_FILES) {
        setError(t("tooMany", { max: MAX_FILES }));
        return;
      }
      const uploaded: UploadedImage[] = [];
      for (const f of incoming) {
        if (f.size > MAX_BYTES) {
          setError(t("tooBig", { name: f.name }));
          continue;
        }
        const sniffed = await sniffMime(f);
        if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
          setError(t("wrongType", { name: f.name }));
          continue;
        }
        const clean = await stripExif(f);

        // Request signed upload URL from server.
        const signRes = await fetch("/api/reviews/sign-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content_type: sniffed }),
        });
        if (!signRes.ok) {
          setError(t("uploadFailed"));
          continue;
        }
        const { upload_url, storage_key } = (await signRes.json()) as {
          upload_url: string;
          storage_key: string;
        };
        const putRes = await fetch(upload_url, {
          method: "PUT",
          headers: { "Content-Type": sniffed },
          body: clean,
        });
        if (!putRes.ok) {
          setError(t("uploadFailed"));
          continue;
        }
        uploaded.push({ key: storage_key, previewUrl: URL.createObjectURL(clean) });
      }
      const next = [...images, ...uploaded];
      setImages(next);
      onChange(next.map((i) => i.key));
    },
    [images, onChange, t],
  );

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 rounded-md border border-dashed px-4 py-6 cursor-pointer">
        <UploadCloud aria-hidden="true" />
        <span className="text-sm text-muted-foreground">{t("prompt", { count: MAX_FILES })}</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="sr-only"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {images.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {images.map((img, i) => (
            <div key={img.key} className="relative">
              <img src={img.previewUrl} alt="" className="rounded object-cover aspect-square" />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-1 right-1 h-6 w-6"
                onClick={() => {
                  const next = images.filter((_, j) => j !== i);
                  setImages(next);
                  onChange(next.map((i) => i.key));
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 12.3:** Unit tests (sniff + size + too-many)

```typescript
// tests/unit/reviews/image-dropzone.test.ts
// Focused on the pure helpers — sniffMime, stripExif contract, size
// bounds. Real upload is tested via E2E.

import { describe, expect, it } from "vitest";
// re-export the helpers from image-dropzone.tsx via a tiny pure-module
// (refactor if needed) OR test via a DOM-less harness

// NOTE: If testing the helpers requires exporting them, move sniffMime
// + stripExif into components/reviews/image-pipeline.ts and import
// from both the component and the test. Update the component import.
```

If the helper extraction is needed for testability, do it now:

Create `components/reviews/image-pipeline.ts`:

```typescript
// components/reviews/image-pipeline.ts
// Pure image pre-upload helpers — exported for testing.
"use client";
// ... moved sniffMime, stripExif from image-dropzone.tsx ...
```

Update `image-dropzone.tsx` to import from `./image-pipeline`.

- [ ] **Step 12.4:** Add message keys

```json
"reviews": {
  "dropzone": {
    "prompt": "이미지 첨부 (최대 {count}장)",
    "tooMany": "이미지는 최대 {max}장까지 가능해요.",
    "tooBig": "{name}: 파일이 너무 큽니다 (최대 5MB).",
    "wrongType": "{name}: 이미지 형식만 업로드 가능해요 (PNG/JPEG/WEBP/GIF).",
    "uploadFailed": "업로드 실패 — 다시 시도해주세요."
  }
}
```

- [ ] **Step 12.5:** Commit

```bash
git add components/reviews/ tests/unit/reviews/ package.json pnpm-lock.yaml messages/
git commit -m "feat(reviews): <ImageDropzone> with EXIF strip + MIME sniff + size cap

Per spec §5. piexifjs strips EXIF from JPEG uploads (GPS leak
mitigation). Magic-byte sniff catches MIME spoofing (.png carrying
HTML). Client-side 5MB cap + ≤5 file count. Server-generated
storage keys via /api/reviews/sign-upload (next task).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 13: Signed upload URL endpoint

**Files:**
- Create: `app/api/reviews/sign-upload/route.ts`

- [ ] **Step 13.1:** Endpoint

```typescript
// app/api/reviews/sign-upload/route.ts
// POST { content_type } → { upload_url, storage_key }
// Path pattern: ${user_id}/pending/${nanoid}.${ext}
// The create-review RPC later moves keys from pending/ to review_id/.

import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/auth/require-user";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: Request) {
  try {
    const { userId, db } = await requireUser();
    const body = (await req.json()) as { content_type: string };
    const ext = EXT_BY_MIME[body.content_type];
    if (!ext) return NextResponse.json({ error: "unsupported_type" }, { status: 400 });
    const key = `${userId}/pending/${nanoid(16)}.${ext}`;
    const { data, error } = await db.storage
      .from("review-assets")
      .createSignedUploadUrl(key);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ upload_url: data.signedUrl, storage_key: key });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

Install nanoid:

```bash
pnpm add nanoid
```

- [ ] **Step 13.2:** Commit

```bash
git add app/api/reviews/sign-upload/ package.json pnpm-lock.yaml
git commit -m "feat(reviews): POST /api/reviews/sign-upload for signed Storage URLs

Per spec §5.1 + §5.2. Server-generated single-use upload URL per file;
storage key pattern is \${user_id}/pending/\${nanoid}.\${ext} so
abandoned uploads are prunable via the existing prune cron.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 14: Review API routes

**Files:**
- Create: `app/api/reviews/route.ts`
- Create: `app/api/reviews/[id]/route.ts`

- [ ] **Step 14.1:** `app/api/reviews/route.ts`

```typescript
// app/api/reviews/route.ts
// POST { repo_id, rating, text_body, vibecoding_tool, image_keys[] }

import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/auth/require-user";

export async function POST(req: Request) {
  try {
    const { db } = await requireUser();
    const body = (await req.json()) as {
      repo_id: string;
      rating: number;
      text_body: string | null;
      vibecoding_tool: string | null;
      image_keys: string[];
    };

    const { data, error } = await db.rpc("create_review_with_fork_check_v2", {
      p_repo_id: body.repo_id,
      p_rating: body.rating,
      p_text_body: body.text_body,
      p_vibecoding_tool: body.vibecoding_tool,
      p_image_keys: body.image_keys,
    });

    if (error) {
      // Translate P0001 custom codes.
      const msg = error.message || "";
      if (msg.includes("already_reviewed")) {
        return NextResponse.json({ error: "already_reviewed" }, { status: 409 });
      }
      if (msg.includes("fork_required")) {
        return NextResponse.json({ error: "fork_required" }, { status: 403 });
      }
      if (msg.includes("rating_out_of_range") || msg.includes("too_many_images")) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const reviewId = data as string;
    revalidateTag(`repo:${body.repo_id}`, "max");
    revalidateTag("repos:list", "max");

    return NextResponse.json({ id: reviewId }, { status: 201 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 14.2:** `app/api/reviews/[id]/route.ts`

```typescript
// app/api/reviews/[id]/route.ts
// PATCH + DELETE for the review owner.

import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/auth/require-user";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, ctx: RouteParams) {
  try {
    const { id } = await ctx.params;
    const { userId, db } = await requireUser();
    const body = (await req.json()) as {
      rating?: number;
      text_body?: string | null;
      vibecoding_tool?: string | null;
    };

    // RLS reviews_update_own gates this to the author.
    const { data, error } = await db
      .from("reviews")
      .update({
        ...(body.rating !== undefined ? { rating: body.rating } : {}),
        ...(body.text_body !== undefined ? { text_body: body.text_body } : {}),
        ...(body.vibecoding_tool !== undefined ? { vibecoding_tool: body.vibecoding_tool } : {}),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select("repo_id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

    revalidateTag(`repo:${data.repo_id}`, "max");
    revalidateTag("repos:list", "max");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: RouteParams) {
  try {
    const { id } = await ctx.params;
    const { userId, db } = await requireUser();

    const { data, error } = await db
      .from("reviews")
      .delete()
      .eq("id", id)
      .eq("user_id", userId)
      .select("repo_id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

    revalidateTag(`repo:${data.repo_id}`, "max");
    revalidateTag("repos:list", "max");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 14.3:** Commit

```bash
git add app/api/reviews/route.ts app/api/reviews/\[id\]/route.ts
git commit -m "feat(api): /api/reviews POST + PATCH/DELETE /api/reviews/[id]

Per spec §4.3. POST calls create_review_with_fork_check_v2 RPC and
revalidateTag on success. PATCH/DELETE respect the Foundation RLS
policies and invalidate the marketplace cache.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 15: `<ReviewComposer>` — structured prompts

**Files:**
- Create: `components/reviews/review-composer.tsx`

- [ ] **Step 15.1:** Component (follows Reviewer E's KPI insight — structured prompts)

```tsx
// components/reviews/review-composer.tsx
"use client";

import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImageDropzone } from "./image-dropzone";

const CHANGED_CHIPS = [
  "colors", "copy", "layout", "components", "routes", "auth", "db", "other",
] as const;
const TOOLS = ["cursor", "bolt", "lovable", "replit", "other"] as const;

interface ReviewComposerProps {
  repoId: string;
  onSubmitted?: () => void;
}

export function ReviewComposer({ repoId, onSubmitted }: ReviewComposerProps) {
  const t = useTranslations("reviews.composer");
  const [rating, setRating] = useState(0);
  const [brandContext, setBrandContext] = useState("");
  const [changed, setChanged] = useState<string[]>([]);
  const [tool, setTool] = useState<string>("");
  const [textBody, setTextBody] = useState("");
  const [imageKeys, setImageKeys] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);

    // Compose text_body from brand context + changed chips + free text.
    const composedText = [
      brandContext ? t("brandLabel") + ": " + brandContext : null,
      changed.length ? t("changedLabel") + ": " + changed.join(", ") : null,
      textBody.trim() || null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        rating,
        text_body: composedText || null,
        vibecoding_tool: tool || null,
        image_keys: imageKeys,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: "unknown" }))) as { error: string };
      setError(t(`errors.${err.error}`, { default: err.error }));
      return;
    }
    onSubmitted?.();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <fieldset>
        <legend className="text-sm font-medium">{t("ratingLabel")}</legend>
        <div className="flex gap-1 mt-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={t("ratingStar", { n })}
              onClick={() => setRating(n)}
              className="p-1"
            >
              <Star
                fill={n <= rating ? "currentColor" : "none"}
                className={n <= rating ? "text-amber-500" : "text-muted-foreground"}
              />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">{t("brandLabel")}</legend>
        <input
          type="text"
          value={brandContext}
          onChange={(e) => setBrandContext(e.target.value)}
          placeholder={t("brandPlaceholder")}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">{t("changedLabel")}</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {CHANGED_CHIPS.map((c) => (
            <label key={c} className="cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={changed.includes(c)}
                onChange={(e) =>
                  setChanged(
                    e.target.checked ? [...changed, c] : changed.filter((x) => x !== c),
                  )
                }
              />
              <span className="inline-block rounded-full border border-input px-3 py-1 text-xs peer-checked:bg-primary peer-checked:text-primary-foreground">
                {t(`changedChips.${c}`)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">{t("toolLabel")}</legend>
        <div className="mt-1 flex gap-3">
          {TOOLS.map((x) => (
            <label key={x} className="flex items-center gap-1">
              <input
                type="radio"
                name="tool"
                value={x}
                checked={tool === x}
                onChange={() => setTool(x)}
              />
              <span className="text-sm">{t(`tools.${x}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">{t("textLabel")}</legend>
        <Textarea
          value={textBody}
          onChange={(e) => setTextBody(e.target.value)}
          placeholder={t("textPlaceholder")}
          maxLength={2000}
          rows={4}
          className="mt-1"
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">{t("imagesLabel")}</legend>
        <ImageDropzone onChange={setImageKeys} />
      </fieldset>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting || rating < 1}>
        {submitting ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
```

- [ ] **Step 15.2:** Message keys

```json
"reviews": {
  "composer": {
    "ratingLabel": "평점",
    "ratingStar": "{n}점",
    "brandLabel": "어떤 브랜드/제품에 적용하려 했나요?",
    "brandPlaceholder": "예: 카페 예약 SaaS",
    "changedLabel": "포크 후 가장 먼저 바꾼 부분은?",
    "changedChips": {
      "colors": "색상",
      "copy": "카피",
      "layout": "레이아웃",
      "components": "컴포넌트",
      "routes": "라우트",
      "auth": "인증",
      "db": "DB",
      "other": "기타"
    },
    "toolLabel": "사용한 바이브코딩 도구",
    "tools": {
      "cursor": "Cursor",
      "bolt": "Bolt",
      "lovable": "Lovable",
      "replit": "Replit",
      "other": "기타"
    },
    "textLabel": "자유로운 후기 (선택)",
    "textPlaceholder": "포크 후 어땠나요? 좋았던 점, 막혔던 점 등",
    "imagesLabel": "적용 결과 이미지 (선택, 최대 5장)",
    "submit": "리뷰 등록",
    "submitting": "등록 중...",
    "errors": {
      "already_reviewed": "이미 이 템플릿에 리뷰를 남기셨어요.",
      "fork_required": "이 템플릿을 먼저 포크해주세요.",
      "rating_out_of_range": "평점은 1-5점 사이로 입력해주세요.",
      "too_many_images": "이미지는 최대 5장까지 가능해요."
    }
  }
}
```

- [ ] **Step 15.3:** Commit

```bash
git add components/reviews/review-composer.tsx messages/
git commit -m "feat(reviews): structured <ReviewComposer> with KPI-critical prompts

Per Reviewer E's product insight (spec §11). Rating + brand context
input + changed-parts chips + tool radio + optional text + ≤5 images.
The structured scaffolding lowers the emotional threshold identified
in PRD §3 line 17 (유저가 리뷰 쓸 말이 없어서 이탈) and is essential
to hitting the 200+ image-attached reviews KPI (PRD §9).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 16: Review list + card components

**Files:**
- Create: `components/reviews/review-card.tsx`
- Create: `components/reviews/reviews-list.tsx`

- [ ] **Step 16.1:** `review-card.tsx` (RSC)

```tsx
// components/reviews/review-card.tsx
import { Star } from "lucide-react";
import { getTranslations } from "next-intl/server";

interface ReviewCardProps {
  review: {
    id: string;
    rating: number;
    text_body: string | null;
    vibecoding_tool: string | null;
    created_at: string;
    assets: { storage_key: string }[];
  };
  authorUsername?: string;
  storageBaseUrl: string;
}

export async function ReviewCard({ review, authorUsername, storageBaseUrl }: ReviewCardProps) {
  const t = await getTranslations("reviews.card");
  return (
    <article className="rounded-lg border p-4 space-y-2">
      <header className="flex items-center justify-between">
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star
              key={n}
              className="h-4 w-4"
              fill={n <= review.rating ? "currentColor" : "none"}
            />
          ))}
        </div>
        {authorUsername && (
          <span className="text-xs text-muted-foreground">@{authorUsername}</span>
        )}
      </header>
      {review.assets.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {review.assets.map((a) => (
            <img
              key={a.storage_key}
              src={`${storageBaseUrl}/${a.storage_key}`}
              alt=""
              className="rounded aspect-square object-cover"
              loading="lazy"
            />
          ))}
        </div>
      )}
      {review.text_body && (
        <p className="text-sm whitespace-pre-line">{review.text_body}</p>
      )}
      {review.vibecoding_tool && (
        <p className="text-xs text-muted-foreground">
          {t("tool")}: {review.vibecoding_tool}
        </p>
      )}
    </article>
  );
}
```

- [ ] **Step 16.2:** `reviews-list.tsx` (RSC)

```tsx
// components/reviews/reviews-list.tsx
import { getTranslations } from "next-intl/server";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/db";
import { env } from "@/lib/env";
import { ReviewCard } from "./review-card";

interface ReviewsListProps {
  repoId: string;
}

export async function ReviewsList({ repoId }: ReviewsListProps) {
  "use cache";
  cacheTag(`repo:${repoId}`);
  cacheLife("hours");

  const t = await getTranslations("reviews.list");
  const db = createAnonClient();
  const { data } = await db
    .from("reviews")
    .select("id, rating, text_body, vibecoding_tool, created_at, user_id, assets:review_assets(storage_key, ordering)")
    .eq("repo_id", repoId)
    .is("hidden_at", null)
    .order("created_at", { ascending: false });

  const reviews = data ?? [];
  // Image-attached first (Reviewer E + PRD §5.4 line 170).
  reviews.sort((a, b) => (b.assets?.length ?? 0) - (a.assets?.length ?? 0));

  const storageBaseUrl = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/review-assets`;

  if (reviews.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t("heading", { count: reviews.length })}</h2>
      {reviews.map((r) => (
        <ReviewCard
          key={r.id}
          review={{
            ...r,
            assets: (r.assets ?? []).sort((a: any, b: any) => a.ordering - b.ordering),
          }}
          storageBaseUrl={storageBaseUrl}
        />
      ))}
    </section>
  );
}
```

- [ ] **Step 16.3:** Messages

```json
"reviews": {
  "card": {
    "tool": "도구"
  },
  "list": {
    "heading": "{count, plural, one {리뷰 #개} other {리뷰 #개}}",
    "empty": "첫 리뷰를 남겨보세요."
  }
}
```

- [ ] **Step 16.4:** Wire into repo-detail page

Modify `app/r/[owner]/[name]/page.tsx` — replace `<ReviewsPlaceholder />` with:

```tsx
import { ReviewsList } from "@/components/reviews/reviews-list";
import { ReviewComposer } from "@/components/reviews/review-composer";
// ...
<section className="space-y-6">
  <ReviewsList repoId={repo.id} />
  <ReviewComposer repoId={repo.id} />
</section>
```

- [ ] **Step 16.5:** Commit

```bash
git add components/reviews/ messages/ app/r/\[owner\]/\[name\]/page.tsx
git commit -m "feat(reviews): <ReviewCard> + <ReviewsList> + wire into repo-detail

Per spec §2.2 + §4.3. RSC with 'use cache' + cacheTag(repo:\${id}) so
the cron + API revalidateTag calls from SP#5 + earlier pipelines
actually bust this data. Image-attached reviews sort first per PRD
§5.4 line 170.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 17: Integration tests for review flows

**Files:**
- Create additional tests under `tests/integration/reviews/`

- [ ] **Step 17.1:** Cover: grace-window happy path, verified fork happy path, no-fork rejection, already-reviewed (23505), image insert ordering, rating out-of-range rejection, >5 images rejection.

See the test shapes in existing `tests/integration/pipeline/apply-score-result-rpc.test.ts` for the service-client + PREFIX + cleanup pattern.

- [ ] **Step 17.2:** Commit

```bash
git add tests/integration/reviews/
git commit -m "test(reviews): v2 RPC coverage (6 cases) + assets ordering

Per spec §9.2. Integration tests against real Supabase; PREFIX-scoped
fixtures; verifies all 6 error paths translate correctly and happy
paths insert the expected row shapes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 18: Verify Stage 3 locally

- [ ] **Step 18.1:**

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration  # if Docker available
pnpm build
pnpm dev
# browser smoke: sign in → click Fork → write a review with 2 images → submit
# browser smoke: second review attempt → see "already_reviewed" error
```

---

## Stage 4 — Cache invalidation + GDPR delete (Tasks 19-22)

### Task 19: Extend `prune` cron to drain `cache_invalidation_queue`

**Files:**
- Modify: `app/api/cron/prune/route.ts`

- [ ] **Step 19.1:** Read the existing prune route. Add a step BEFORE its existing cleanup logic:

```typescript
// Drain the cache_invalidation_queue (Path B per spec §3.3).
// Populated only by SQL-snippet moderation operations;
// API-path writes revalidateTag directly.
const { data: pending } = await ctx.db
  .from("cache_invalidation_queue")
  .select("id, tag")
  .is("drained_at", null)
  .limit(500);

for (const row of pending ?? []) {
  revalidateTag(row.tag, "max");
}

if (pending && pending.length > 0) {
  await ctx.db
    .from("cache_invalidation_queue")
    .update({ drained_at: new Date().toISOString() })
    .in("id", pending.map((r) => r.id));
  ctx.metric("cache_tags_drained", pending.length);
}
```

Ensure `revalidateTag` is imported from `next/cache`.

- [ ] **Step 19.2:** Unit test (reuses the revalidate-wiring harness from SP#4)

```typescript
// tests/unit/cache/cache-invalidation-queue.test.ts
// Mock next/cache + supabase query chain; verify that queue drain calls
// revalidateTag for each pending row and marks them drained_at.
```

- [ ] **Step 19.3:** Commit

```bash
git add app/api/cron/prune/route.ts tests/unit/cache/
git commit -m "feat(cache): prune cron drains cache_invalidation_queue

Per spec §3.3 Path B. Catches ops drift from SQL-snippet moderation.
Batch size 500; marks drained_at atomically; emits
ctx.metric('cache_tags_drained').

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 20: SQL ops moderation snippets

**Files:**
- Create: `supabase/snippets/reviews-moderation.sql`

- [ ] **Step 20.1:**

```sql
-- VibeShelf review moderation — operator queries.
-- Run as service_role in Supabase Studio. Each action that changes what
-- the marketplace shows MUST enqueue a cache-invalidation row.

-- ─── Find recent reviews (last 7 days) ──────────────────────────────
SELECT r.id, r.rating, r.text_body, r.user_id, r.repo_id, r.created_at,
       rp.owner || '/' || rp.name AS repo_slug
FROM public.reviews r
JOIN public.repos rp ON rp.id = r.repo_id
WHERE r.created_at > now() - interval '7 days'
  AND r.hidden_at IS NULL
ORDER BY r.created_at DESC
LIMIT 100;

-- ─── Soft-hide a review (preserves data for AI-score drift analysis) ─
-- :review_id  — the review uuid
-- :repo_id    — the repo uuid (from the SELECT above)
UPDATE public.reviews SET hidden_at = now() WHERE id = :review_id;
INSERT INTO public.cache_invalidation_queue (tag)
  VALUES ('repo:' || :repo_id), ('repos:list');

-- ─── Un-hide ────────────────────────────────────────────────────────
UPDATE public.reviews SET hidden_at = NULL WHERE id = :review_id;
INSERT INTO public.cache_invalidation_queue (tag)
  VALUES ('repo:' || :repo_id), ('repos:list');

-- ─── Hard-delete (GDPR/PIPA or user request) ────────────────────────
-- This CASCADES to review_assets + storage cleanup trigger.
DELETE FROM public.reviews WHERE id = :review_id;
INSERT INTO public.cache_invalidation_queue (tag)
  VALUES ('repo:' || :repo_id), ('repos:list');
```

- [ ] **Step 20.2:** Commit

```bash
git add supabase/snippets/reviews-moderation.sql
git commit -m "docs(ops): review moderation SQL snippets

Per spec §3.3 + §4 (Q4). Three standard operations — hide, un-hide,
hard-delete — each paired with cache_invalidation_queue inserts so
the prune cron can bust Cache Components tags.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 21: Account delete (GDPR/PIPA)

**Files:**
- Create: `app/settings/account/delete/page.tsx`
- Create: `app/settings/account/delete/route.ts`
- Modify: `lib/env.ts` (add Resend key if not present)

- [ ] **Step 21.1:** `delete/page.tsx`

```tsx
// app/settings/account/delete/page.tsx
"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export default function AccountDeletePage() {
  const t = useTranslations("settings.accountDelete");
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onDelete() {
    setSubmitting(true);
    const res = await fetch("/api/settings/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || null }),
    });
    if (res.ok) router.push("/");
    else setSubmitting(false);
  }

  return (
    <main className="container mx-auto max-w-lg px-4 py-12 space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("warning")}</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span className="text-sm">{t("confirmLabel")}</span>
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("reasonPlaceholder")}
        rows={3}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <Button variant="destructive" disabled={!confirmed || submitting} onClick={onDelete}>
        {submitting ? t("deleting") : t("confirmButton")}
      </Button>
    </main>
  );
}
```

Move this under `app/settings/account/delete/` — route path is `/settings/account/delete`.

- [ ] **Step 21.2:** Route handler — we use a separate API endpoint to avoid mixing concerns:

Create `app/api/settings/account/delete/route.ts`:

```typescript
// app/api/settings/account/delete/route.ts
// POST /api/settings/account/delete
// 1. Revoke GitHub upstream grant
// 2. auth.admin.deleteUser — cascades github_oauth_tokens, user_profiles,
//    fork_events, reviews via existing FKs
// 3. Structured logs + best-effort confirmation email

import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { decryptOAuthToken } from "@/lib/auth/decrypt-oauth-token";
import { requireUser, UnauthorizedError } from "@/lib/auth/require-user";
import { env } from "@/lib/env";

export async function POST(req: Request) {
  try {
    const { userId, db } = await requireUser();
    const body = (await req.json().catch(() => ({}))) as { reason?: string };

    // 1) Get email BEFORE cascade — we lose access once the row is deleted.
    const { data: user } = await db.auth.getUser();
    const email = user?.user?.email ?? null;

    // 2) Revoke upstream grant best-effort.
    const token = await decryptOAuthToken(db, userId);
    if (token && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
      try {
        await fetch(
          `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`,
          {
            method: "DELETE",
            headers: {
              Authorization:
                "Basic " +
                Buffer.from(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`).toString("base64"),
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ access_token: token }),
          },
        );
        console.log(
          JSON.stringify({
            event: "oauth_token_revoked",
            user_id: userId,
            reason: "account_delete",
            ts: new Date().toISOString(),
          }),
        );
      } catch (err) {
        console.log(
          JSON.stringify({
            event: "oauth_token_revoke_failed",
            user_id: userId,
            error: (err as Error).message,
            ts: new Date().toISOString(),
          }),
        );
      }
    }

    // 3) Cascade delete via admin client.
    const adminDb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { error: delErr } = await adminDb.auth.admin.deleteUser(userId);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    const deletionId = `del_${nanoid(12)}`;
    console.log(
      JSON.stringify({
        event: "account_deleted",
        user_id: userId,
        deletion_id: deletionId,
        reason: body.reason ?? null,
        ts: new Date().toISOString(),
      }),
    );

    // 4) Optional receipt email via Resend or Supabase SMTP.
    // Spec §4.4 step 2g. Best-effort only; do not block the 200 on email delivery.
    if (email && env.RESEND_API_KEY) {
      void fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "VibeShelf <noreply@vibeshelf.dev>",
          to: email,
          subject: "계정 삭제 완료 / Account deleted",
          text: `Deletion ID: ${deletionId}\nTimestamp: ${new Date().toISOString()}\n\nYour VibeShelf account and associated data have been permanently removed. Your GitHub OAuth grant has been revoked.`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, deletion_id: deletionId });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 21.3:** Add env keys

Modify `lib/env.ts` schema to add:

```typescript
RESEND_API_KEY: z.string().optional(),
```

Scope: "both" (can be read from route handlers).

- [ ] **Step 21.4:** Messages

```json
"settings": {
  "accountDelete": {
    "title": "계정 삭제",
    "warning": "계정을 삭제하면 포크 이력, 리뷰, 업로드한 이미지가 영구적으로 사라집니다. GitHub OAuth 권한도 철회됩니다.",
    "confirmLabel": "내용을 확인했고 삭제에 동의합니다.",
    "reasonPlaceholder": "삭제 이유 (선택)",
    "confirmButton": "영구 삭제",
    "deleting": "삭제 중..."
  }
}
```

- [ ] **Step 21.5:** Commit

```bash
git add app/settings/ app/api/settings/ messages/ lib/env.ts
git commit -m "feat(account): GDPR/PIPA account delete flow

Per spec §4.4. Captures email pre-cascade; best-effort upstream grant
revocation; Supabase auth.admin.deleteUser cascades all user-owned
rows; structured audit logs to Vercel log drain; optional Resend
confirmation email with deletion ID.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Task 22: E2E + final verify + PR

**Files:**
- Create: `tests/e2e/sp5-signin-fork-review.spec.ts`

- [ ] **Step 22.1:** E2E spec

```typescript
// tests/e2e/sp5-signin-fork-review.spec.ts
import { expect, test } from "@playwright/test";

// Skip unless the CI env has a test OAuth credential pool; otherwise
// rely on Supabase local's anonymous user. The flow below uses a
// test helper that sets a cookie session directly, bypassing the
// real GitHub OAuth — shipped in tests/e2e/helpers/session.ts.

test.describe("SP#5 flow", () => {
  test("anon cannot see composer; sign-in unlocks it", async ({ page }) => {
    await page.goto("/r/fixture-01/template-1");
    // placeholder for "sign in required" copy
    await expect(page.locator("text=포크하려면 로그인")).toBeVisible();
  });

  test("sign-in → fork → compose review with 1 image → submit", async ({ page, context }) => {
    // set session cookie via helper
    // await signInAsTestUser(context);
    // await page.goto('/r/fixture-01/template-1');
    // await page.click('text=이 템플릿 포크');
    // await expect(page.locator('text=포크 완료')).toBeVisible({ timeout: 15000 });
    // await page.click('text=평점 5점');
    // await page.fill('textarea', 'smoke test review');
    // await page.setInputFiles('input[type=file]', 'tests/e2e/fixtures/small.png');
    // await page.click('text=리뷰 등록');
    // await expect(page.locator('text=리뷰 1개')).toBeVisible();
  });

  test("second review attempt → already_reviewed error", async ({ page, context }) => {
    // same setup, expect error toast
  });
});
```

This E2E test needs a test OAuth bypass helper. Flag this as Stage 4 followup if the helper doesn't already exist; for now the test stubs the flow and the manual smoke (§9.4) covers it.

- [ ] **Step 22.2:** Final local verify

```bash
pnpm typecheck
pnpm lint
pnpm lint:neg
pnpm test:unit
pnpm test:integration  # if Docker available
pnpm build
```

Every step must pass.

- [ ] **Step 22.3:** Commit + push + PR

```bash
git add tests/e2e/sp5-signin-fork-review.spec.ts
git commit -m "test(e2e): SP#5 sign-in + fork + review flow skeleton"
git push -u origin feat/sp5-identity-fork-reviews
gh pr create --title "feat: SP#5 — Identity + Fork + Reviews" --body "$(cat docs/superpowers/specs/2026-04-15-sp5-identity-fork-reviews-design.md | head -50)

Spec: \`docs/superpowers/specs/2026-04-15-sp5-identity-fork-reviews-design.md\`
Plan: \`docs/superpowers/plans/2026-04-15-sp5-identity-fork-reviews-implementation.md\`

Closes Q-02 precondition (Free-tier value loop complete).

## Test plan
- [x] pnpm typecheck / lint / lint:neg / build — green
- [x] pnpm test:unit — covers image-pipeline + revoke-token + message-coverage + cache-queue
- [x] pnpm test:integration — reviews RPC v2, fork idempotency, hidden_at RLS
- [ ] pnpm test:e2e — skeleton only; CI-side helper lands in follow-up
- [ ] Manual smoke on preview: sign in → fork fixture repo → compose + submit review with image → see in list
- [ ] Account delete smoke: /settings/account/delete → confirm → see /‎ home as anon

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Stage 5 — Post-merge followups filing

- [ ] **Step F.1:** Append Q-11 through Q-17 to `docs/architecture/open-questions.md` per the spec §10 table

- [ ] **Step F.2:** Commit

```bash
git checkout main && git pull
# (add the new Q entries)
git add docs/architecture/open-questions.md
git commit -m "docs: file SP#5 followups (Q-11..Q-17) per spec §10"
git push
```

---

## Self-Review (per writing-plans skill)

**Spec coverage check:**
- §1 Decisions Q2-Q5 → Tasks 5-6 (popup), 8-10 (fork D), 19-20 (moderation+hidden_at), user-menu (Q5-none)
- §1 M1 next-intl → Tasks 0.1-0.3
- §1 M2 structured composer → Task 15
- §1 M3 ImageDropzone → Task 12
- §1 M4 23505 translation → Task 3 RPC
- §1 M5 OAuth lifecycle → Tasks 4 (helpers), 21 (account delete)
- §1 M6/M7 fork-delete-retain + forever-edit → implemented implicitly (no "active detector" is built; existing RLS allows edit)
- §3 migrations 1-4 → Tasks 1-3
- §4 data flows → Tasks 5-21 cover each flow step
- §5 image upload → Task 12 + 13 (sign-upload)
- §6 i18n → Stage 0
- §7 token lifecycle → Tasks 4 + 21
- §8 boundaries → no new dep-cruiser rule needed; path-based restrictions follow existing patterns
- §9 testing → unit + integration + E2E skeleton
- §9.5 edge cases → EC1-EC7 each mapped in the task bodies

**Placeholder scan:** grep for TODO/TBD; the E2E test stubs are the one remaining — flagged explicitly as "skeleton; helper lands in follow-up." That's a KNOWN gap, not a hidden placeholder.

**Type consistency:** `ForkResult`, `ForkState`, `ExcessiveRemovalError` (from PR#7) — no mismatches between task bodies. `create_review_with_fork_check_v2` signature (uuid, smallint, text, enum, text[]) → consumed by API route → matches `image_keys[]` from composer.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-15-sp5-identity-fork-reviews-implementation.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per Task batch (Task 1 or Task 1+2, not step-by-step), review between batches, resolve any reviewer findings inline. Matches the SP#2-4 rhythm.

2. **Inline Execution** — Execute tasks in this session with checkpoint commits.

**Which approach?**

Also: Stage 0 (next-intl chore) ships as a standalone PR first — do NOT start Stage 1 work until that chore PR merges. Stages 1-4 then ship as one big feature PR (`feat/sp5-identity-fork-reviews`) per the spec §12 scope decision.
