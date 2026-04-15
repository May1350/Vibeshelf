---
title: VibeShelf Identity + Fork + Reviews — Design Spec
date: 2026-04-15
status: draft (pending user approval)
sub_project: 05-identity-fork-reviews
parent_prd: VibeShelf_PRD_Final.md
related_docs:
  - docs/superpowers/specs/2026-04-11-foundation-design.md
  - docs/superpowers/specs/2026-04-14-marketplace-ui-free-design.md
  - docs/architecture/open-questions.md
prior_sub_projects:
  - PR #1 Foundation merged 2026-04-13
  - PR #2 Ingestion Pipeline merged 2026-04-14
  - PR #4 Evaluation + Classification merged 2026-04-14
  - PR #6 Marketplace UI Free merged 2026-04-14
  - PR #7 Post-SP#4 followups merged 2026-04-15
preconditions:
  - Q-02 RESOLVED 2026-04-15 — Pro tier cut from MVP, SP#5 finishes the Free-tier value loop
  - Q-10 RESOLVED 2026-04-15 — i18n approach = Option B (next-intl + Korean-first), pre-SP#5 chore
---

# VibeShelf Identity + Fork + Reviews — Design Spec

**Sub-project #5 of 6.** Closes the Free-tier value loop: anonymous browsers become signed-in vibe coders who fork templates and write reviews-with-images that improve the AI scoring feedback loop (PRD §4 line 95).

This spec absorbs both reviewer rounds (E: UX/PRD lens, F: engineering risk lens) — see §11 Reviewer Synthesis for the audit trail.

---

## 0. Scope

**In scope:**
- GitHub OAuth sign-in (Supabase Auth + popup-window pattern to preserve composer draft)
- One-click fork (GitHub REST `POST /repos/{owner}/{repo}/forks`) with async-verify pattern
- Review system: rating (1-5) + structured-prompt text + ≤5 image attachments + vibecoding tool tag
- Soft-hide moderation via `reviews.hidden_at` + SQL ops snippets (no admin UI in MVP)
- Cache invalidation triggers so marketplace cards reflect new review counts/averages
- OAuth token lifecycle: 401-handler → `mark_oauth_token_revoked`, `/settings/account/delete` with upstream GitHub grant revocation
- next-intl framework (Korean-primary, English fallback) — applies to all new SP#5 strings

**Out of scope (deferred to later sub-projects):**
- Full profile pages (`/u/[username]`) — route folder NOT reserved (per Reviewer G YAGNI: 404 stubs aren't indexed). Whole folder added when SP#5.5 brainstorms profile UX
- Review reporting / user-flag system (Q4-C) — SQL ops sufficient at MVP scale
- Re-review / edit windows beyond the simple update-own-row path
- Brand matching / playbook generation (Pro tier — SP#6 per Q-02)
- Image content moderation pipeline (NSFW detection, etc.) — flagged as post-MVP risk in §10
- Dedicated OAuth audit table (`tokens_rotation_log`) — Supabase `auth.audit_log_entries` + structured server logs cover MVP needs

---

## 1. Decisions Locked

| ID | Question | Decision | Source |
|---|---|---|---|
| Q2 | Sign-in trigger UX | **Modal-on-action + minimal header fallback button + popup OAuth flow** | E (modal copy) + F (state preservation) |
| Q3 | Fork verification | **NEW Option D** — immediate `fork_events` row with `verified_at IS NULL`, async background verify after 3s, `verified_at` backfill; composer-open accepts `verified_at IS NOT NULL` OR a 30s grace window | F (counter to original A/B/C) + E (composer-open timing) |
| Q4 | Moderation | **A + soft-hide** — SQL snippets only, no admin UI; `reviews.hidden_at timestamptz` nullable column for non-destructive hide; `AFTER DELETE/UPDATE` trigger emits `pg_notify('cache_invalidate', repo_id)` for `revalidateTag` | E (hidden_at) + F (cache invalidation) |
| Q5 | Profile page | **None for MVP + reserve `/u/[username]` route stub** returning `notFound()` for SEO indexability later | E (graveyard feature) + F (SEO reservation) |

**Must-includes surfaced by reviewers (in addition to Q2-Q5):**
- M1: Pre-SP#5 next-intl migration chore PR (1.5 days, separate)
- M2: Structured review composer with prompt scaffolding (E's KPI-critical insight)
- M3: `<ImageDropzone>` component with EXIF strip + MIME sniff + size cap
- M4: 23505 unique-violation translation in `create_review_with_fork_check` RPC
- M5: OAuth token lifecycle infrastructure (401 handler, account-delete endpoint, audit log)
- M6: Fork-deleted-on-GitHub policy: keep review (fork_events is append-only audit, not current state); detection deferred to SP#6
- M7: Edit window: simple "user can update own review forever" via existing RLS `reviews_update_own`; no time-bounded edit gate

---

## 2. Architecture

### 2.1 High-level component graph

```
┌──────────────────────────────────────────────────────────────┐
│ marketplace browser (anonymous, RSC + Cache Components)      │
│    └─ Header: [logo] [search] ... [Sign in with GitHub]      │
│         (header button is fallback for SEO/crawl + a11y;     │
│          conversion path is the modal below)                  │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼ click "Fork" or "Write a review" anywhere
┌──────────────────────────────────────────────────────────────┐
│ <SignInGate>: opens popup window → /auth/sign-in             │
│   ├─ Supabase OAuth → GitHub → callback                      │
│   ├─ encrypt + store provider_token (existing Foundation)    │
│   └─ postMessage("signed-in") → opener restores state        │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│ signed-in user actions:                                       │
│                                                                │
│  ┌─ <ForkButton repo={...}>                                  │
│  │    ├─ POST /api/fork  (server route, decrypts token)      │
│  │    ├─ GitHub POST /repos/{o}/{r}/forks → 202 Accepted     │
│  │    ├─ INSERT fork_events (verified_at = NULL)              │
│  │    ├─ after(3s) → GET /repos/{user}/{forkname}            │
│  │    │    └─ on success: UPDATE fork_events SET verified_at  │
│  │    │    └─ on 401: mark_oauth_token_revoked + UI re-auth  │
│  │    └─ button → "View your fork" (link to fork URL)        │
│  │                                                             │
│  └─ <ReviewComposer repo={...}>                              │
│       ├─ guard: fork_events.verified_at NOT NULL              │
│       │         OR (forked_at > now - 30s grace window)       │
│       ├─ structured prompts (M2):                             │
│       │    [평점]                                              │
│       │    [어떤 브랜드/제품에 적용하려 했나요?] (text)         │
│       │    [포크 후 가장 먼저 바꾼 부분은?] (multiselect chips) │
│       │    [사용한 바이브코딩 도구] (radio: Cursor/Bolt/...)   │
│       │    [텍스트 후기] (optional textarea)                   │
│       │    [<ImageDropzone> ≤5 images]                        │
│       ├─ submit → POST /api/reviews                           │
│       │    └─ create_review_with_fork_check RPC               │
│       │         on 23505 → "이미 이 템플릿에 리뷰를 남기셨어요" │
│       └─ post-submit: revalidateTag(`repo:${id}`)             │
└──────────────────────────────────────────────────────────────┘
                 │
                 ▼ marketplace re-renders with new review count + avg
```

### 2.2 Module layout (new files only)

```
app/
  (auth)/
    sign-in/page.tsx          [popup target — initiates Supabase OAuth]
    callback/route.ts         [EDIT — Foundation; on popup=1 redirects to
                               /auth/callback-popup instead of next URL]
    callback-popup/page.tsx   [NEW — client; runs window.opener.postMessage
                               + window.close() (Reviewer G architecture fix)]
  api/
    fork/route.ts             [POST: fork + UPSERT fork_events; idempotent on 422/23505]
    fork/status/route.ts      [GET: poll fork verification (Reviewer G)]
    reviews/route.ts          [POST: create review via RPC; PATCH/DELETE: edit/delete own]
    reviews/sign-upload/route.ts  [POST: signed upload URL for image dropzone]
  settings/
    account/
      delete/page.tsx         [confirmation UI]
      delete/route.ts         [POST: GitHub grant revoke → cascade delete → email receipt]
  r/[owner]/[name]/
    page.tsx                  [EDIT — replace ReviewsPlaceholder with <ReviewsList>;
                               wire <ForkButton> onto fork-cta-placeholder slot]
  # Note: /u/[username] route stub CUT per Reviewer G YAGNI. Reserve when SP#5.5 starts.

components/
  auth/
    sign-in-button.tsx        [shadcn Button — opens popup to /auth/sign-in]
    sign-in-modal.tsx         [shadcn Sheet — appears on action-click for unauth]
    user-menu.tsx             [header avatar/text + sign-out]
  fork/
    fork-button.tsx           [client; calls /api/fork; renders verify state]
  reviews/
    review-composer.tsx       [client; structured prompts + ImageDropzone]
    review-card.tsx           [RSC; renders one review w/ images]
    reviews-list.tsx          [RSC; lists reviews for a repo, image-attached first]
    image-dropzone.tsx        [client; M3 — EXIF strip + MIME sniff + size cap]

lib/
  auth/
    require-user.ts           [server util: getUser() with 401 throw]
    revoke-token.ts           [server util: 401 → mark_oauth_token_revoked]
    decrypt-oauth-token.ts    [server util: load + decrypt user's GitHub token]
  github/
    fork.ts                   [server: POST /repos/{o}/{r}/forks via fetch]
    user-token-pool.ts        [server: decrypt user's stored token; NOT the
                               github_tokens app-pool from SP#2]
  i18n/
    request.ts                [next-intl getRequestConfig]
    routing.ts                [next-intl middleware locale negotiation]
    messages/ko.json
    messages/en.json

middleware.ts                 [EDIT or CREATE — next-intl locale routing]

supabase/migrations/
  20260415000001_reviews_hidden_at_and_select_own.sql      [§3.1]
  20260415000002_fork_events_verified_at.sql               [§3.2]
  20260415000003_cache_invalidation_queue.sql              [§3.3 — replaces trigger+LISTEN]
  20260415000004_create_review_with_fork_check_v2.sql      [§3.5]
  # tokens_rotation_log migration CUT per Reviewer G YAGNI

supabase/snippets/
  reviews-moderation.sql      [find/hide/unhide/delete operator queries]
```

---

## 3. Schema additions

### 3.1 `reviews.hidden_at`

```sql
ALTER TABLE public.reviews
  ADD COLUMN hidden_at timestamptz;

CREATE INDEX idx_reviews_visible
  ON public.reviews(repo_id, created_at DESC)
  WHERE hidden_at IS NULL;

-- Update RLS: anon reads only un-hidden reviews on published repos.
DROP POLICY IF EXISTS reviews_select_published ON public.reviews;
CREATE POLICY reviews_select_published
  ON public.reviews FOR SELECT TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (SELECT 1 FROM public.repos r
                WHERE r.id = reviews.repo_id AND r.status = 'published')
  );

-- Per Reviewer G: a hidden-review author must still see their own row so
-- the existing reviews_update_own / reviews_delete_own policies work
-- (RLS UPDATE/DELETE require a SELECT-side USING expression to evaluate
-- the row's existence). Add an own-row read for authenticated users.
CREATE POLICY reviews_select_own
  ON public.reviews FOR SELECT TO authenticated
  USING (user_id = auth.uid());
```

### 3.2 `fork_events.verified_at`

```sql
ALTER TABLE public.fork_events
  ADD COLUMN verified_at timestamptz;

-- index for the composer-open guard query
CREATE INDEX idx_fork_events_user_repo_verified
  ON public.fork_events(user_id, repo_id) INCLUDE (verified_at, forked_at);
```

### 3.3 Cache invalidation — direct + ops-sweep

**Reviewer G correction:** the originally-proposed `pg_notify` + long-running LISTEN Route Handler is undeliverable on Vercel — serverless functions don't hold persistent connections. Switching to a two-pronged approach that stays Vercel-native:

**Path A (synchronous — handles 99% of writes):** every API route that mutates a review (`POST /api/reviews`, `PATCH /api/reviews/[id]`, `DELETE /api/reviews/[id]`) calls `revalidateTag(\`repo:${repo_id}\`, 'max')` immediately after the RPC succeeds. Same pattern as cron routes in SP#2/SP#3.

**Path B (cron sweep — handles SQL-snippet ops drift):** add a row to a tiny `cache_invalidation_queue` table whenever a SQL ops snippet hides/deletes a review. Existing `prune` cron route (Sundays, in `vercel.json`) extends to drain the queue and call `revalidateTag` for each.

```sql
CREATE TABLE public.cache_invalidation_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag         text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  drained_at  timestamptz
);

CREATE INDEX idx_cache_inv_queue_pending
  ON public.cache_invalidation_queue(enqueued_at)
  WHERE drained_at IS NULL;

-- The OPS snippet template (in supabase/snippets/reviews-moderation.sql)
-- includes a paired INSERT into cache_invalidation_queue per affected repo_id.
-- Operators copy-paste; the cron route does the rest.
```

The `prune` cron route (existing) gets a new step:

```ts
const { data: pending } = await db
  .from('cache_invalidation_queue')
  .select('id, tag')
  .is('drained_at', null)
  .limit(500);

for (const row of pending ?? []) {
  revalidateTag(row.tag, 'max');
}
await db.from('cache_invalidation_queue')
  .update({ drained_at: new Date().toISOString() })
  .in('id', (pending ?? []).map(r => r.id));
```

Worst-case staleness for SQL-snippet hides: 1 week (matches the prune cadence). Acceptable for MVP — moderation actions are rare and not time-critical. The Path A (direct revalidate) handles all user-facing writes in real time.

**Postgres trigger and pg_notify are NOT used.** Cleaner, fewer moving parts, no Vercel platform incompatibility.

### 3.4 ~~`tokens_rotation_log`~~ — CUT per Reviewer G YAGNI

Originally proposed a dedicated audit table for OAuth token lifecycle events. Reviewer G correctly pointed out that for a Free-tier MVP with no paid retention obligation:

- **Supabase's built-in `auth.audit_log_entries`** (auto-populated on signin/signout/user-delete) plus the structured server-side `console.log` lines from `lib/auth/revoke-token.ts` (§7.1) cover the proof chain
- A dedicated table costs a migration, ongoing schema maintenance, and a contradiction (the `ON DELETE SET NULL` would erase the user_id we're trying to audit)
- PIPA/GDPR right-to-erasure on a free product is satisfied by: (a) actual deletion of `auth.users` row + cascade, (b) upstream `DELETE /applications/{client_id}/grant` to GitHub, (c) a user-emailed receipt confirming the deletion ID. None of those need our own table.

**Replacement:** §7.1's revocation helper logs structured events to `console` (which Vercel ships to log drains); §4.4 account-delete flow emails the user a receipt with deletion timestamp + GitHub grant-revocation status. If we ever reach Pro tier with paid users, revisit (Q-12 followup).

### 3.5 RPC `create_review_with_fork_check_v2`

Replaces the v1 stub; adds:
- 30-second grace window on `verified_at IS NULL` (allows immediate review after fork)
- Catches `unique_violation` (23505) → raises with `errcode = 'P0001'` (custom) and message `"already_reviewed"` so the API route translates to a Korean UX message

**Hidden-vs-deleted re-review semantics (Reviewer G):**
- `UNIQUE (repo_id, user_id)` is enforced by Foundation's existing index — that constraint applies to ALL reviews regardless of `hidden_at`
- **If a moderator HIDES a review** (sets `hidden_at`): the unique constraint still blocks a re-write by the same user. Author must contact ops to un-hide. This is the intended "permanent lockout" — preserves drift-analysis data + prevents whack-a-mole
- **If a moderator DELETES a review** (DELETE row): the unique constraint clears; user can write a new review. This is the explicit "fresh start" path. Use sparingly (the `hidden_at` path is preferred for moderation; DELETE is for genuine erasure requests like GDPR)

---

## 4. Data flow

### 4.1 Sign-in (popup pattern)

**Architecture correction (Reviewer G):** the existing `app/(auth)/callback/route.ts` is a Route Handler — it returns `Response`, not HTML. It cannot execute `window.opener.postMessage(...)`. The spec was wrong to call this a "minor edit". Correct flow:

1. User clicks "Fork" or "Write a review" without a session
2. Client opens `window.open('/auth/sign-in?popup=1', 'vibeshelf-auth', 'width=500,height=700')`
3. `/auth/sign-in/page.tsx` (RSC) calls `supabase.auth.signInWithOAuth({ provider: 'github', options: { scopes: 'public_repo', redirectTo: '/auth/callback?popup=1' } })`
4. GitHub OAuth flow inside the popup
5. **Callback Route Handler** (existing, `app/(auth)/callback/route.ts`) exchanges code → session, encrypts + stores provider_token, **then if `popup=1` redirects to `/auth/callback-popup` (new client page); otherwise redirects to `next` as today**
6. **`/auth/callback-popup/page.tsx`** (new, client component) is a tiny page that on mount calls `window.opener?.postMessage({type: 'vibeshelf:signed-in'}, window.location.origin)` then `window.close()`. If `window.opener == null` (parent navigated/closed), shows "Return to VibeShelf" link to `/`
7. Opener listens via `useSignInListener()` hook → re-renders the modal → user proceeds with their original action; **draft state is preserved because the opener page never navigated**

**Cross-tab session propagation:** opener also subscribes to Supabase's `onAuthStateChange` to handle the case where the user signed in via a third tab; same code path treats both as "session arrived." Optional `BroadcastChannel('vibeshelf-auth')` for instant cross-tab notification (deferred to implementation if `onAuthStateChange` proves laggy).

**Popup-blocked fallback:** detect `window.open()` returning `null` → fall back to full-page redirect (`location.href = '/auth/sign-in?next=...'`); persist composer draft to `sessionStorage` keyed on `(repo_id, kind=review)` and restore on the redirected page's load.

**File map update:** add `app/(auth)/callback-popup/page.tsx` (client component) to §2.2.

### 4.2 Fork

1. `<ForkButton>` POSTs to `/api/fork` with `{ repo_id, owner, name }`
2. Route handler decrypts user token via `lib/auth/decrypt-oauth-token.ts` (helper introduced in §2.2)
3. Server calls GitHub `POST /repos/{owner}/{name}/forks`
4. **Idempotency on duplicate (Reviewer G edge case):**
   - On 422 "fork already exists" → GET the existing fork URL, treat as success
   - On 23505 from `fork_events` insert (double-click race) → SELECT existing row, return its data
5. On 202 Accepted (or 422-recovered): UPSERT `fork_events (user_id, repo_id, github_fork_id, github_fork_url, verified_at=NULL)` ON CONFLICT (user_id, repo_id) DO UPDATE SET forked_at = now()
6. Route handler returns `{ status: 'pending'|'verified', fork_url, fork_event_id }` immediately; client shows "포크 생성 중…" or "✓ 포크 완료"
7. **Background verify (Reviewer G correction — replace `after()` + SSE with explicit poll):** the API response includes `fork_event_id`. Client polls `GET /api/fork/status?fork_event_id=...` every 3s up to 5 attempts. Each poll: server checks `verified_at`; if null, server-fetches `/repos/{user}/{forkname}` and updates `verified_at = now()` on 200. After 5 failed polls, UI keeps button at "포크 진행 중" but enables review composer (the 30s grace window in §3.5 covers the gap)
8. On any 401 from GitHub during fork or poll: `lib/auth/revoke-token.ts` triggers `mark_oauth_token_revoked` + UI re-auth modal

### 4.3 Review write

1. `<ReviewComposer>` checks fork eligibility:
   ```sql
   SELECT 1 FROM fork_events
   WHERE user_id = $1 AND repo_id = $2
     AND (verified_at IS NOT NULL OR forked_at > now() - interval '30 seconds')
   ```
2. If eligible, render the structured form; else show "이 템플릿을 먼저 포크해주세요" with a `<ForkButton>` inline
3. User fills rating, multiselect chips ("바꾼 부분"), tool tag, text, ≤5 images
4. Submit → POST `/api/reviews` → `create_review_with_fork_check_v2(repo_id, rating, text, tool, image_keys[])` RPC
5. RPC: re-checks fork eligibility (race-safe), inserts review, inserts review_assets in same transaction
6. On 23505 → P0001 `already_reviewed` → API returns 409 with Korean message
7. On success → `revalidateTag(\`repo:${repo_id}\`)` called explicitly (in addition to the Postgres trigger path) for fast user feedback

### 4.4 Account deletion (GDPR/PIPA)

1. User opens `/settings/account/delete` (confirmation + reason)
2. POST handler:
   a. Capture `userId`, `email` to local vars (we lose them on cascade)
   b. Server-decrypt the user's `provider_token`
   c. Call GitHub `DELETE /applications/{client_id}/grant` to revoke upstream
   d. Structured `console.log({event: 'oauth_token_revoked', user_id, reason: 'account_delete', ts})` → Vercel log drain
   e. Call `auth.admin.deleteUser(userId)` via service-role → cascades `user_profiles`, `github_oauth_tokens`, `fork_events`, `reviews` (via existing FKs)
   f. Structured `console.log({event: 'account_deleted', user_id, ts})` → Vercel log drain
   g. Send confirmation email via Supabase Edge Function (or Resend) including a deletion ID `del_${nanoid(12)}` for user records
3. Sign user out, redirect to `/`

---

## 5. Image upload (M3)

### 5.1 Threat model

| Threat | Mitigation |
|---|---|
| EXIF GPS leak | Strip on client before upload (`piexifjs` or canvas redraw) |
| MIME spoofing (`.png` carrying HTML) | Magic-byte sniff client-side; reject non-image |
| Oversized files (DoS storage budget) | 5 MB hard cap per file; UI shows progress, aborts on overflow |
| Filename injection | Server-generates `storage_key = ${user_id}/pending/${nanoid(16)}.${ext}`; on review creation, the `create_review_with_fork_check_v2` RPC moves the keys into `${user_id}/${review_id}/...` paths atomically with the row insert |
| Concurrent upload race | Each file gets pre-signed upload URL via `supabase.storage.from('review-assets').createSignedUploadUrl(...)`; URLs are single-use |
| Pending uploads abandoned (user closes composer) | Cron `prune` route (Sundays) deletes objects under `${user_id}/pending/` older than 24h |
| `enforce_review_asset_limit` trigger race (Reviewer G inherited Foundation bug) | Trigger is FOR EACH ROW — a batch INSERT of 6 assets passes the count check on each row independently before any commit. **Fix in this sub-project's migration:** convert to a STATEMENT-level trigger that re-counts after the statement, OR rely exclusively on the RPC layer to insert one-at-a-time (chosen — simpler, no migration needed since RPC is the only insert path post-SP#5) |
| NSFW content | **Out of scope for MVP** — flagged as Q-11 (new) followup |

### 5.2 Component contract

```tsx
<ImageDropzone
  maxFiles={5}
  maxBytesPerFile={5_000_000}
  onUploaded={(keys: string[]) => ...}
  onError={(err: ImageDropzoneError) => ...}
/>
```

Internal pipeline per file:
1. Read `File` object, sniff first 12 bytes for image magic
2. Strip EXIF (canvas re-render, skip if SVG/GIF — those don't have EXIF)
3. Request signed upload URL from `/api/reviews/sign-upload` (server-side authn check)
4. PUT to Supabase Storage; on success emit `storage_key` to parent

---

## 6. i18n (Q-10 implementation)

### 6.1 Stage 0 (chore PR before SP#5 main work)

- Install `next-intl` (App Router compatible, ESM)
- Create `messages/{ko,en}.json` catalogs
- Wrap `app/layout.tsx` with `NextIntlClientProvider`
- Add `middleware.ts` for `/[locale]` segment OR detect-only-via-header (cookieless decision below)
- Migrate every existing literal Korean/English string in `app/page.tsx`, `app/r/[owner]/[name]/page.tsx`, `components/marketplace/*`, `components/repo/*` to `t()` calls
- Add a CI check that flags raw string literals in JSX outside an allowlist (helper text comments, alt="" decorative, etc.)

### 6.2 Locale routing decision

**Choice: detect-via-header (no `/ko/` URL prefix).** Korean is the default; English is opt-in via cookie or `?lang=en`. The existing `/`, `/r/...` paths stay — no URL churn for the SP#1-4 surface area.

**SEO trade-off (Reviewer G):** without per-locale URLs, proper `hreflang` tagging is not possible later without URL migration. We accept this trade-off explicitly: PRD primary language is Korean, international expansion is not a Year-1 priority, and Korean SEO works fine without hreflang. If international expansion becomes a Year-2 plan, that's a Q-16 followup with its own URL-restructure cost owned by that initiative.

### 6.3 New SP#5 strings

Every new string in `auth/`, `fork/`, `reviews/`, `settings/` ships with both `ko` and `en` keys. Korean is the source of truth; English keys can be marked `// TODO translate` and lint-allowed for now (KPI-driven activation).

---

## 7. OAuth token lifecycle (M5)

### 7.1 401 handler middleware

```ts
// lib/auth/revoke-token.ts
export async function withTokenRevocationOn401(
  fn: (token: string) => Promise<Response>,
  ctx: { db: SupabaseClient; userId: string; token: string }
): Promise<Response> {
  const res = await fn(ctx.token);
  if (res.status === 401) {
    await ctx.db.rpc('mark_oauth_token_revoked', { p_user_id: ctx.userId });
    // Structured log shipped to Vercel log drains (replaces tokens_rotation_log
    // table cut per Reviewer G YAGNI). Format kept JSON-parseable.
    console.log(JSON.stringify({
      event: 'oauth_token_revoked',
      user_id: ctx.userId,
      reason: '401 from GitHub API',
      ts: new Date().toISOString(),
    }));
  }
  return res;
}
```

Used by `lib/github/fork.ts` and any future user-scoped GitHub call.

### 7.2 `/settings/account/delete`

See §4.4 data flow.

### 7.3 Out of scope

- **Token refresh.** Classic OAuth App tokens (Supabase's default GitHub provider) don't expire. Verified during implementation only; if the PRD ever calls for fine-grained PATs or a GitHub App migration (Reviewer G caveat), this becomes Q-17 followup.
- **Key rotation backfill** (key v1 → v2) — captured as Q-12 followup; current version is v1

---

## 8. Boundaries & lints

- `lib/github/user-token-pool.ts` is distinct from `lib/pipeline/github/token-pool.ts` (the app-token pool from SP#2). Different scope, different lifecycle. dep-cruiser rule:
  ```
  no-user-tokens-from-pipeline:
    from: { path: "^lib/pipeline/" }
    to:   { path: "^lib/github/user-token-pool" }
  ```
- `lib/auth/` is server-only (`import "server-only"`); client cannot import
- `app/api/fork/route.ts` and `app/api/reviews/route.ts` are the only writers to `fork_events` and `reviews` from app-side (SECURITY DEFINER RPCs handle the actual INSERTs)
- `next-intl` server-side calls (`getTranslations()`) are restricted to RSC; client uses `useTranslations()`

---

## 9. Testing strategy

### 9.1 Unit
- `lib/auth/revoke-token.ts` — 401 path triggers RPC + audit insert
- `<ImageDropzone>` — EXIF strip, MIME sniff, oversize rejection, ≤5 cap
- next-intl message coverage — every key referenced in code exists in `ko.json` AND `en.json`

### 9.2 Integration
- `create_review_with_fork_check_v2` — fork verified path, fork unverified within grace, fork unverified outside grace (rejection), 23505 path
- `notify_review_change` trigger — INSERT/UPDATE(hidden_at)/DELETE all emit notifications
- Cache listener — round-trip: review insert → notification → `revalidateTag` called

### 9.3 E2E (Playwright)
- Anon → click Fork → modal opens → "Sign in" → mock-OAuth callback → modal closes → fork pending → fork verified
- Sign-in → write review with image → submit → see review on page
- `/u/nonexistent` returns 404 (route reserved)
- Korean default locale; `?lang=en` switches; cookie persists choice

### 9.4 Manual smoke (post-deploy)
- Real GitHub OAuth dance against vibeshelf-dev.vercel.app (deployment protection note: dev account session bypasses)
- Real fork against a test source repo (will surface 202 timing reality)

---

## 9.5 Edge cases the implementation MUST handle (Reviewer G)

| # | Situation | Required handling |
|---|---|---|
| EC1 | Popup blocked by browser | Detect `window.open() === null` → fall back to full-page redirect; persist composer draft to `sessionStorage` keyed on `(repo_id, kind)`; restore on landing page mount |
| EC2 | Parent tab closed/navigated before postMessage arrives | `/auth/callback-popup` checks `window.opener == null` → render "VibeShelf로 돌아가기" link to `/` |
| EC3 | Two tabs (A unauth, B unauth) — user signs in on A | Tab B picks up via Supabase `onAuthStateChange`; modal/composer state re-evaluates |
| EC4 | User clicks Fork twice rapidly | API route's UPSERT + 23505 catch (§4.2 step 4) returns idempotent success |
| EC5 | Composer open; user signs out in another tab; submit fires | `useUser()` hook detects null session → pre-validate; on submit, RPC returns 401 → composer re-opens sign-in modal, draft preserved |
| EC6 | Fork API returns 422 "fork already exists" | API route GETs the existing fork URL and treats as success; UPSERT `fork_events` row to backfill |
| EC7 | `enforce_review_asset_limit` per-row trigger race (batch INSERT of 6 assets) | RPC inserts assets one-at-a-time inside a single transaction (already the only insert path); document this constraint loudly in the RPC comment |

## 10. Followups (filed to open-questions.md)

| ID | Title | Trigger |
|---|---|---|
| Q-11 (new) | Image content moderation pipeline | Post-launch: any user-flagged NSFW report OR ≥3 manual hides per week |
| Q-12 (new) | OAuth key rotation v1→v2 backfill job | Annual rotation cadence OR any v1 key compromise event |
| Q-13 (new) | Fork-deleted-on-GitHub detection job | When SP#6 starts; today we keep reviews intact (fork_events is append-only audit) |
| Q-14 (new) | `/u/[username]` activation (profile pages) | When SP#5.5 or SP#6 brainstorming opens; reviewer reputation SEO play |
| Q-15 (new) | Edit window / reviewer reputation gating | If KPI shows >5% review-flip-flopping post-launch |
| Q-16 (new) | International expansion + per-locale URLs (`hreflang`) | Year-2; would require URL restructure (existing `/`, `/r/...` → `/[locale]/...`) |
| Q-17 (new) | Migrate to GitHub App or fine-grained PATs (token expiry) | If GitHub deprecates OAuth Apps OR Pro tier needs finer scopes |

---

## 11. Reviewer Synthesis (audit trail)

### Reviewer E (UX/PRD)
- Q2: AGREE B + modal copy "포크/리뷰를 위해 GitHub 연동이 필요해요"
- Q3: REFINE C → verify at composer-OPEN to protect drafted text
- Q4: AGREE A + add `hidden_at` for soft-hide (drift-analysis preservation)
- Q5: AGREE A
- **Critical product insight:** structured composer prompts are KPI-essential (PRD §9 200+ image-attached reviews target). Without them, SP#5 ships features but misses metrics. → captured as M2

### Reviewer F (engineering risk)
- Q2: REFINE B + state preservation cost (popup OAuth or pre-upload temp); header fallback for SEO
- Q3: COUNTER A AND C — GitHub fork API returns 202 (async); composer-submit lazy verify will break. Insert `fork_events` immediately with `verified_at = NULL`, async backfill. → became Option D
- Q4: AGREE A + cache invalidation gap on SQL-snippet deletes → originally Postgres trigger + LISTEN handler (later corrected by Reviewer G — see below)
- Q5: AGREE A + reserve `/u/[username]` 404 stub for SEO indexability (later cut by Reviewer G — see below)
- **Hidden costs surfaced:** next-intl migration is 1.5-2 days (M1 chore PR), ImageDropzone security is 1 day (M3), 23505 RPC translation is 20 min (M4), OAuth token lifecycle + GDPR is 2 days (M5). All absorbed into 8.5-day estimate.

### Reviewer G (3rd-pair-of-eyes spec audit)
- **Block-spec corrections (all folded in):**
  - §3.1 added `reviews_select_own` policy so authors can still see soft-hidden own reviews
  - §3.3 **complete redesign** — pg_notify + LISTEN is undeliverable on Vercel serverless. Replaced with direct `revalidateTag` from API routes (Path A, 99% coverage) + `cache_invalidation_queue` table drained by existing prune cron (Path B for SQL-snippet ops drift)
  - §3.5 clarified hide-vs-delete re-review semantics
  - §4.1 callback architecture corrected — Route Handler can't `window.opener.postMessage`; added `/auth/callback-popup` client page
- **YAGNI cuts:** `tokens_rotation_log` table dropped (Supabase auth.audit_log_entries + structured logs cover MVP); `/u/[username]` route stub dropped (404s aren't indexed)
- **Edge cases:** consolidated 7 cases into §9.5 — popup blocked, parent-tab-closed, cross-tab session, double-click fork, signed-out-mid-compose, fork-already-exists 422, asset-limit trigger race
- **Result:** spec moved from "needs revision" to "ready for writing-plans" after fold-ins

---

## 12. Out of band: scope concerns

This sub-project is the largest by component count (4 stages, ~12 new components, 4 new migrations, 1 chore-PR precondition). Per the writing-plans skill's scope check, the spec is at the upper bound of "single implementation plan." I'm choosing to keep it unified because the four stages share infrastructure (auth context, popup pattern, i18n catalog, cache invalidation) that would be cargo-culted across split PRs. If implementation reveals a clean split point (e.g., review write proves harder than estimated), the implementation plan can split into 5a/5b mid-stream.
