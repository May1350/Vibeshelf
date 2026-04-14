# VibeShelf — Open Questions (parking lot)

**Created:** 2026-04-11 after Foundation brainstorming two-reviewer pass.
**Purpose:** Decisions surfaced during Foundation brainstorming but deliberately not resolved yet. Re-open at the named trigger point — not before (to avoid premature commitments) and not after (to avoid forgetting).

## How to use this file

- **Do NOT resolve items here.** This is a parking lot, not a decision log. Resolution happens in the relevant sub-project's brainstorming session.
- When you reach an item's "Re-open when" trigger, move the discussion into that session, decide, and **delete the item from this file** (or move it to a `resolved-questions.md` if you want an audit trail).
- New open questions surfaced during future brainstorming sessions should be appended here.

---

## Q-01. Automated demo screenshot capture (PRD §5.1 priority 3)

**Status:** Deferred (re-confirmed 2026-04-14 during sub-project #2 brainstorming). Ingestion MVP populates tiers 1, 2, 4 only via `extractReadmeMedia`. Tier 3 (`demo_screenshot` asset kind) remains reserved in the schema with no writer. Re-open if post-launch analytics show a material CTR gap for repos lacking README media (≥15%) or if a user complaint stream emerges.

**Triggering this item also reopens `future-separation-plan.md`** — trigger #2 (headless Chrome) activates the moment this is implemented.

---

## Q-02. MVP scope — Pro tier inclusion (PRD §10)

**Status:** Deferred. User has not yet confirmed whether to follow the PRD's W4 Pro-inclusion plan or cut it.

**Background:** PRD §10 schedules Stripe + brand matching + playbook generation for week 4. Reviewer R2 (codex-rescue) explicitly flagged this as unrealistic because week 4 piles new features on top of unfinished pipeline accuracy work, OAuth flows, review moderation, and screenshot reliability from earlier weeks.

**Options:**
1. **Follow PRD as written** — Pro tier in 4-week MVP.
2. **Cut Pro from MVP** — launch Free tier only, use month 2 for pipeline quality + security hardening, add Pro in month 3.
3. **Pro with reduced scope** — brand matching only, playbook post-launch; or playbook only, brand matching post-launch.

**Re-open when:** Before starting sub-project #5 brainstorming (Identity+Fork+Reviews). By that point we will know whether sub-projects #1-4 fit within their W1-W3 budget. If they don't, the Pro decision becomes forced.

---

## Q-03. Pro-tier schema (brand_profiles, subscriptions, playbooks)

**Status:** Deferred entirely to sub-project #6.

**Background:** Foundation Q2 chose to keep Pro-tier tables out of scope (YAGNI — Pro UX not finalized). Reviewer R2 (codex-rescue) pushed back, but the rebuttal held: only `repos.supports_brand_matching` boolean was added to Foundation as the single Pro-related signal that must be populated by the ingestion pipeline.

**Open sub-questions (answer in sub-project #6 brainstorming):**
1. `brand_profiles` columns: `primary_color`, `secondary_color`, `accent_color`, `background`, `foreground`, `font_family`, `corner_style`, `logo_storage_key`. PK: user_id.
2. `subscriptions` columns: Stripe subscription id, tier, status, current_period_end. PK: user_id. Source of truth = Stripe webhooks.
3. `playbooks` columns: generated text per (repo_id, target_tool), prompt version for re-generation, cached generation TTL.
4. CSS variable detection logic: where does this live (new ingestion job?) and what sets `repos.supports_brand_matching`?
5. Iframe rendering strategy: cross-origin restrictions when applying CSS override to third-party repo demos — is this even feasible, or does the preview happen inside our own rendering domain?

**Re-open when:** Starting sub-project #6 brainstorming. Blocked on Q-02 — if Pro is cut from MVP, this item's re-open date shifts.

---

## Q-04. Mutable data re-fetch / re-score policy — RESOLVED in sub-project #2

**Status:** Resolved 2026-04-14. The weekly `refreshJob` (`lib/pipeline/jobs/refresh.ts`) implements the mutable-data policy:

1. **README drift:** `readme_sha` compared on every refresh via the `/repos/{owner}/{name}/readme` endpoint. Drift triggers re-fetch and re-extract. (Re-scoring is sub-project #3's responsibility; refresh only records the drift signal.)
2. **Metric drift:** Current values overwrite previous in `repos` on every refresh. Historical snapshots live in `repo_scores.raw_response` (sub-project #3).
3. **Repo rename/transfer:** GitHub auto-redirects via 301 on `/repos/{owner}/{name}`; the response body carries the new `full_name`, which the refresh job compares and updates. `fork_events` + `reviews` FK to `repos.id` (stable uuid), so the rename doesn't break their links.
4. **Repo deleted/archived:** 404 on refresh → `status='removed'`. `fork_events`, `reviews`, `repo_assets` CASCADE-retain per their FK clauses from Foundation (no explicit retention policy; rows stay linked via `repos.id`).
5. **License change mid-curation:** Non-permissive license detected on refresh → `status='removed'` immediately (no grandfathering, no manual review). Users whose forks exist still have them; we just stop surfacing the repo in the marketplace.

**Retired sub-questions:** all 5 answered above. The only remaining judgment call is dormant-deletion retention (kept as `status='dormant'` indefinitely for now — sub-project #6 may revisit).

---

## Q-05. Gemini scoring throughput realism — RESOLVED in sub-project #3

**Status:** Resolved 2026-04-14. See `docs/superpowers/specs/2026-04-14-evaluation-classification-design.md`.

**Resolutions:**
1. **Concurrency model**: Sequential per-run with implicit GitHub token-pool rate pacing. Paid tier 1000 RPM is 2+ orders above MVP scale (20-50 repos/day). Cost kill-switch via `RequestBudget` (500 calls/run default, 2000/run for rescore).
2. **Malformed README handling**: `has_readme=false` path → metadata-only Gemini call with `documentation_score=0`. Binary/oversized READMEs truncated at 8000 chars or sliced to target sections.
3. **Manual review queue UI**: `status='needs_review'` enum value + `supabase/snippets/` operator queries. No dedicated UI in MVP — operators use Supabase Studio + SQL snippets.
4. **Prompt version rollout**: `SCORING_PROMPT_VERSION` semver string in `lib/pipeline/gemini/scoring-prompt.ts`. Monthly rescore cron selects by version mismatch (priority) + 30-day staleness. `RESCORE_DRAIN_MODE` env flag switches to daily cadence for major-version migrations.

**Re-open when:** Starting sub-project #3 brainstorming.

---

## Q-06. Observability, alerting, and SLO baseline

**Status:** Partially addressed in Foundation. Observability primitives exist; alerting policy does not.

**Background:** Foundation ships the `pipeline_runs` table, OTel trace emission from every `runJob()` wrapper, and log drain to Vercel Observability. But the following operational questions are unanswered:

1. **Failure alerting:** What fires when `pipeline_runs.status = 'failed'` exceeds a threshold? Vercel incidents? Slack webhook? Email? Nothing for MVP (check manually)?
2. **Freshness SLO:** "Repos should be scored within N hours of discovery" — what's N? How do we measure?
3. **Cost dashboard:** How do we notice if Gemini bill spikes? Pre-commit manual calculation? Vercel spend alert? Gemini API console check?
4. **Security alerting:** RLS policy violation attempts, failed SECURITY DEFINER function calls, suspicious token_validated_at patterns — where do these land?

**Update 2026-04-14:** Sub-project #3 ships `ScoreJobMetrics` TypeScript schema + 6 operator SQL snippets + `gemini_429_count` threshold documentation (0 = normal, >5 = warning, >20 = quota exhaustion). Full automated alerting still deferred — re-open before first production launch.

**Re-open when:** Before first production launch.

---

## Q-07. GitHub token pool management (surfaced in sub-project #2)

**Status:** New. Implementation exists (`lib/pipeline/github/token-pool.ts`) but operational policy is undefined.

**Background:** The token pool holds PATs / GitHub App installation tokens with scope `'search' | 'rest' | 'graphql'`. The ingestion pipeline rotates them via `acquire_github_token` RPC (SKIP LOCKED). Open operational questions:

1. **Token provisioning:** Who creates the PATs? Rotation cadence (90 days? never unless leaked?). Who owns the process when the pool runs dry?
2. **Disabled token recovery:** `disableToken` sets `disabled_at` on 401. Is there a re-enable path (ops dashboard? manual SQL?) or are disabled tokens dead forever?
3. **Pool sizing:** 2-3 tokens is enough for W1 (200 repos/day). What's the trigger to add a 4th? Daily `api_calls_made` metric ≥ 80% of `5000 × N_tokens`?
4. **`disabled_reason` column:** Currently the reason is logged to stdout only. Adding a text column would make incident triage possible without grepping logs.

**Re-open when:** First production discover run, OR when migrating from PATs to GitHub App installation tokens (Q-07.5), OR when pool exhaustion causes a job failure in prod.

---

## Q-08. Cron route observability gap (surfaced in sub-project #2)

**Status:** New. PostToolUse validation flagged it during route creation.

**Background:** Cron route handlers (`app/api/cron/*/route.ts`) are thin adapters — they auth-check, call `runJob`, return the result. `runJob` writes `pipeline_runs` rows with status/metrics/error, so the job body IS instrumented. But the ROUTE layer has no logging for:

- 401 unauthorized attempts (spam from public endpoint probing)
- Bodyless 5xx before `runJob` even runs (Next.js-level exception)
- Latency between cron trigger and job start (useful for diagnosing Vercel cron drift)

**Options:**
1. Accept gap for MVP (simplest; Vercel function logs already capture 401s and exceptions).
2. Add a lightweight `logRouteEvent` helper that writes to a new `cron_audit` table.
3. Defer to Q-06 (observability baseline) resolution.

**Re-open when:** First production incident where the route-level gap caused blindness, OR when Q-06 lands.

---

## Revision log

- **2026-04-11** — File created during Foundation brainstorming two-reviewer pass. Seeded with Q-01 through Q-06.
- **2026-04-14** — Sub-project #2 (ingestion) brainstorming completed. Q-04 resolved (weekly refreshJob implements mutable-data policy). Q-01 kept deferred (no Puppeteer in MVP). Added Q-07 (token pool operational policy) and Q-08 (cron route observability gap).
- **2026-04-14** — Sub-project #3 (evaluation + classification) shipped. Q-05 resolved. Q-06 partially addressed (metrics schema + SQL snippets + 429 threshold); automated alerting still deferred. Added Issue #4 tracking for Foundation advisory-lock ineffectiveness (session-scoped over HTTP).
