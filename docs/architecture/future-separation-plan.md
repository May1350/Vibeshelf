# VibeShelf — Future Separation Plan (A → B)

**Status:** Deferred. Recorded 2026-04-11 during initial Foundation brainstorming.
**Context:** PRD v3.0 Final (2026.04). Greenfield project. MVP target: 4 weeks.

## TL;DR

We chose **Option A — Single Next.js app on Vercel** for the MVP. This document records the alternative we deliberately deferred (**Option B — Turborepo monorepo with a dedicated worker**), the trigger conditions for revisiting, and the migration path so the split stays cheap when the time comes.

---

## The Choice

### Chosen: A — Single Next.js app on Vercel

- One repo, one Vercel project.
- Web UI, API routes, and the ingestion/evaluation pipeline all live inside a single Next.js app.
- Scheduled work runs via **Vercel Cron** triggering API routes under `app/api/cron/*`.
- Long-running or multi-step crawling/scoring jobs wrap their logic in **Vercel Workflow DevKit (WDK)** steps so they are durable across timeouts, retries, and restarts.

### Rejected (for now): B — Turborepo monorepo with dedicated worker

- `apps/web` (Next.js) + `apps/worker` (standalone Node/TS service) + `packages/db`, `packages/types`.
- Worker runs outside Vercel Functions (e.g., Railway, Fly, a VPS, Vercel Sandbox, or a dedicated Vercel project).
- Cleaner separation of concerns and no serverless timeout ceiling, but doubles env/CI/deploy surface area in MVP.

### Also considered: C — Vercel Services (experimentalServices)

- Single repo, single Vercel project, but `web` and `worker` deploy as separate services via `experimentalServices` in `vercel.json`.
- Rejected because the `experimental` label means thin docs and fewer real-world examples; not worth the operational risk in MVP.

---

## Why A for MVP

1. **Scale fits the platform.** PRD's W1 target is 200 repos, the 3-month target is 2,000. Both fit comfortably inside Vercel Functions + WDK durable steps. No timeout crisis at this scale.
2. **4-week MVP budget.** Infrastructure-splitting work is a tax we can't afford before we've validated the core loop (ingest → score → marketplace → fork).
3. **Single deploy, single env.** One `.env`, one Vercel project, one set of Supabase keys. Debugging, preview deploys, and PR review all stay simple.
4. **Shared types and DB client for free.** The pipeline and the UI both read/write the same Supabase tables. In A they share the same module graph with zero packaging effort.
5. **WDK gives us 80% of B's benefit today.** Durable, resumable steps mean a crawl+score cycle that would have blown the per-function time limit can run as `step.do('fetch-batch') → step.do('score-batch') → step.do('upsert')` without splitting the repo.

---

## Triggers to Revisit (move toward B)

Revisit this decision if **any** of the following become true:

| # | Trigger | Signal |
|---|---------|--------|
| 1 | **Workflow execution budget exceeded** | A single crawl+score cycle no longer finishes within WDK's per-invocation step budget, and splitting into smaller sub-workflows is getting hacky |
| 2 | **Crawler resource profile diverges** | Pipeline needs long-lived TCP connections, headless Chrome with persistent state, or heavy in-memory models — things that fight serverless cold-start and memory limits |
| 3 | **Different deploy cadence needed** | Web UI wants hot deploys many times per day while pipeline wants stability freezes (or vice versa), and coupled deploys start causing incidents |
| 4 | **Team grows past one contributor on pipeline** | A dedicated data/ML person joins and needs their own deploy lane without gating on web PR reviews |
| 5 | **Cost structure flips** | Vercel Function execution time for pipeline work starts dominating the bill vs. a $20/mo worker box that would do the same job |
| 6 | **GitHub API rate-limit management wants process-level state** | Token pool, backoff state, and de-dup caches work better in a single long-lived worker than across many short-lived function invocations |

None of these are expected before **MVP month 3, 2,000 repos, or Puppeteer/sandbox introduction — whichever comes first**. Revisit at the first concrete sign, not preemptively. Trigger #2 (headless Chrome) is specifically noted: the day automated demo screenshots become a real requirement (see `open-questions.md` Q-01), reopen this document regardless of other signals — headless browser execution on the crawl+score path is the single strongest reason to split.

---

## Design-for-Later: keeping the split cheap from day one

Inside Option A, we deliberately shape the code so that the future move to B is a file-move, not a rewrite. **Foundation (sub-project #1) must enforce these conventions:**

### 1. `lib/pipeline/` is self-contained

- All ingestion, scoring, and classification logic lives under `lib/pipeline/` with **zero imports from `app/`** — no Next.js-only APIs, no React, no route helpers, no `next/*` imports.
- Only its entry points are called from API route handlers in `app/api/cron/*`. Those handlers are thin adapters: parse request → call pipeline function → return response.

### 2. DB access goes through `lib/db/`

- Single Supabase client factory. Single typed query surface.
- No `createClient()` calls sprinkled across routes or components.
- When we extract `packages/db`, we move this one directory.

### 3. Shared types in `lib/types/`

- Imported by both UI and pipeline.
- **Zero framework dependencies** inside `lib/types/` — no `next/*`, no `react`, no server-only symbols.

### 4. No Next.js-isms in pipeline code

- No `cookies()`, no `headers()`, no `NextResponse`, no `revalidatePath()`, no `redirect()`.
- If the pipeline needs to invalidate UI state, it writes a row to a `cache_invalidations` table (or uses Vercel Runtime Cache tags) and the web layer reads it on next render. The pipeline never reaches directly into Next.js's cache machinery.

### 5. Env var access is centralized in `lib/env.ts` with zod validation

- The pipeline reads from the same typed object as the UI.
- Moving pipeline code out of Next.js later means pointing the same module at `process.env` directly — no code change required in callers.

### 6. Entry-point contract for every scheduled job

```ts
// lib/pipeline/jobs/<job-name>.ts
export async function runJob(input: JobInput): Promise<JobResult>
```

- Each job is a plain async function — no framework dependencies in its signature.
- The cron API route is a ~3-line wrapper.
- Extraction to a worker = write a new wrapper in the worker process, delete the old route. The job file itself is untouched.

### 7. Secret scope boundary documented

- In `lib/env.ts`, tag each secret with `scope: "web" | "pipeline" | "both"`.
- Future split knows which secrets each side needs without archaeology.

### 8. Storage access goes through `lib/storage/`

- Mirrors rule 2 for Supabase Storage. Single client factory exposing typed helpers (e.g., `uploadRepoAsset`, `uploadReviewImage`, `getSignedUrl`).
- No direct `supabase.storage.*` calls from route handlers, server components, or pipeline jobs.
- When we extract `packages/storage` in the A→B migration, we move this one directory.

### 9. No Next.js cache directives in pipeline code

- Banned inside `lib/pipeline/**`: `'use cache'` directive, `cache()` wrapper, `cacheTag()`, `cacheLife()`, `unstable_cache`, `revalidateTag()`, `revalidatePath()`, `unstable_noStore()`.
- **Rationale:** these APIs are framework-coupled and will not exist in a standalone Node/TS worker. Sneaking them into pipeline code today means the worker move later becomes a rewrite, not a file move.
- **How the pipeline invalidates UI caches without them:** the pipeline writes a row (or tag) to a small `pipeline_cache_invalidations` table (future, not in Foundation), and the web layer reads it from its own side and calls `updateTag()` during its next request cycle. The pipeline never reaches into Next.js's cache machinery directly.

---

## Migration Steps (A → B), when triggered

Rough sketch so future-us knows the shape of the work:

1. **Introduce workspaces.** Convert the repo to a pnpm workspace with a single package (`apps/web`). No behavioral change. Verify preview + production deploys still work.
2. **Extract `packages/db` and `packages/types`.** Move `lib/db/` and `lib/types/` into workspace packages, update imports. Still one deploy target.
3. **Create `apps/worker`.** Scaffold a minimal Node/TS service with its own `package.json`. Import from `packages/db` and `packages/types`.
4. **Move `lib/pipeline/` into `apps/worker/src/pipeline/`.** Because of the design-for-later rules, imports should resolve with only path changes — no API rewrites.
5. **Replace cron API routes with worker-side schedulers.** Either the worker's own cron daemon, or Vercel Cron still triggers an endpoint on the worker.
6. **Provision worker hosting.** Railway / Fly / Render / Vercel Sandbox / dedicated Vercel project — pick whichever matches the trigger reason from the table above.
7. **Split env management.** Web gets web-only secrets (Clerk publishable key, public Supabase anon key, Stripe publishable key). Worker gets pipeline secrets (GitHub PAT pool, Gemini key, Claude key, Supabase service role key). Overlap (DB URL, shared config) goes to both.
8. **Observability split.** Worker ships logs/traces to its own drain; web keeps Vercel observability. Correlate via shared trace IDs if needed.

**Rough effort estimate:**
- **~3 days** if the design-for-later rules were followed throughout MVP.
- **~2 weeks** if they weren't — mostly spent untangling `app/` imports from pipeline logic.

This effort ratio is the entire reason the design-for-later rules are non-negotiable in Foundation.

---

## What this document is NOT

- **Not a spec.** Nothing here gets implemented now.
- **Not a commitment to eventually adopt B.** If we never hit a trigger, we stay on A forever, and that's fine.
- **Not a substitute for Foundation's design doc.** The Foundation spec will reference this document to justify the `lib/pipeline/` / `lib/db/` / `lib/types/` / `lib/env.ts` directory conventions and the "no Next.js-isms in pipeline code" rule.

---

## Revision log

- **2026-04-11** — Created during initial Foundation brainstorming. Choice: A. Review date: **first trigger, MVP month 3, or 2,000 repos — whichever comes first.**
- **2026-04-11** — Updated after Foundation brainstorming two-reviewer pass (superpowers:code-reviewer + codex:codex-rescue). Added rules 8 (storage boundary) and 9 (no Next.js cache directives in pipeline). Tightened trigger caveat to name 2,000 repos and Puppeteer/sandbox introduction as explicit signals.
