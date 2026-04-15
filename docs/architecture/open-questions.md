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

## Q-02. MVP scope — Pro tier inclusion (PRD §10) — RESOLVED 2026-04-15

**Decision:** **Option 2 confirmed by user 2026-04-15.** Pro tier cut from MVP. Free tier ships W4 (target 2026-05-09); Pro work begins month 3 (≈ 2026-06-15) as a separate phase under Q-03 / SP#6.

SP#5 brainstorming opens with Pro-cut as a precondition, freeing Week 4 budget for: (a) production cron smoke test, (b) Q-06 observability alerting, (c) Q-09 image-reliability metric collection, (d) dogfooding before public launch.

---

### Original recommendation (kept for audit trail)

**Burn-rate reality check (SP#4 post-merge review):**

- SP#1 Foundation → 2026-04-11 (Week 1, on schedule)
- SP#2 Ingestion → 2026-04-14 (Week 2, on schedule)
- SP#3 Evaluation+Classification → 2026-04-14 (Week 2 tail, compressed)
- SP#4 Marketplace UI Free → 2026-04-14 (Week 2 tail, compressed)
- **SP#5 Identity+Fork+Reviews (OAuth + fork API + reviews table + moderation queue)** → realistically 1.5–2 weeks → lands ≈ 2026-04-28 to 2026-05-05
- **SP#6 Pro tier (Stripe + brand_profiles + subscriptions + playbooks + CSS-var detection + iframe strategy per Q-03)** → 2–3 weeks minimum

PRD W4 target is 2026-05-09. SP#5 consumes the remaining budget with ~zero slack; Pro-tier work can't reasonably start until 2026-05-05 earliest, i.e. 4 days before the target. Option 1 is infeasible without cutting quality elsewhere (OAuth, review moderation, accuracy tuning — all riskier to compromise than deferring Pro).

**Recommendation:** **Option 2 — cut Pro from MVP.** Rationale:

1. Launch Free tier at W4 as planned; Pro slips to month 3 (≈ 2026-06-15).
2. Buy back Week 4 of MVP for (a) the production cron smoke test (never run end-to-end against real data), (b) Q-06 alerting (automated observability still deferred), (c) image hot-link metric collection for Q-09 (SP#4.5 mirror gate), (d) dogfooding.
3. Option 3 (reduced Pro) is a trap — each Pro sub-feature (brand matching, playbook gen, Stripe) has independent complexity and failure modes; shipping any one half-built damages trust more than shipping none.
4. Free tier alone proves the *valuable insight* of the product (curated templates w/ quality scores + vibecoding-tool compatibility). Pro is monetization layering on top — irrelevant if the Free tier doesn't land clean.

**Re-open when:** User confirms Option 2 (likely combined with SP#5 brainstorming kickoff). If confirmed, this Q resolves and moves to resolved-questions or gets deleted per file convention. SP#6 remains parked at Q-03.

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

## Q-09. Image hot-link reliability metric (surfaced in sub-project #4)

**Status:** New. SP#4 ships with `next/image` + `remotePatterns` allowlist for GitHub-hosted README assets (raw.githubusercontent.com, user-images.githubusercontent.com, github.com — `camo` excluded because GitHub mints fresh tokens that we'd cache stale). SP#4.5 will mirror images into Supabase Storage; the decision trigger is hard data on broken-image rate from production.

**Re-open when:** Post-launch metrics show ≥5% broken-image events on marketplace cards (measure via client-side `onError` beacon or server-side periodic HEAD-check on `repo_assets.external_url`). Implementation lives in SP#4.5 (mirror pipeline + width/height extraction + GIF→MP4 conversion).

---

## Q-10. UI internationalization scope

**Status:** New. SP#4 ships English placeholder strings ("Search templates...", "Filters", "Coming soon", category labels via `humanize(slug)`, etc.). PRD primary language is Korean. Decision: when do we localize, and how?

**Options:**
1. Korean strings inline now (extra ~2 days; blocks SP#4 close — already past that gate).
2. Korean strings as part of SP#5 (Identity + Fork + Reviews) bundled with auth/review-related copy.
3. Defer to Pro tier (SP#6) — assumes vibecoders read English UI.
4. Add `next-intl` and migrate copy incrementally per sub-project.

**Re-open when:** Starting SP#5 brainstorming. The framework choice (#4) needs to be made before any Korean copy lands so we don't pay double-migration cost.

---

## Revision log

- **2026-04-11** — File created during Foundation brainstorming two-reviewer pass. Seeded with Q-01 through Q-06.
- **2026-04-14** — Sub-project #2 (ingestion) brainstorming completed. Q-04 resolved (weekly refreshJob implements mutable-data policy). Q-01 kept deferred (no Puppeteer in MVP). Added Q-07 (token pool operational policy) and Q-08 (cron route observability gap).
- **2026-04-14** — Sub-project #3 (evaluation + classification) shipped. Q-05 resolved. Q-06 partially addressed (metrics schema + SQL snippets + 429 threshold); automated alerting still deferred. Added Issue #4 tracking for Foundation advisory-lock ineffectiveness (session-scoped over HTTP).
- **2026-04-14** — Sub-project #4 (marketplace UI free) shipped. Added Q-09 (image hot-link reliability metric → SP#4.5 mirror) and Q-10 (UI i18n scope → SP#5 trigger).
- **2026-04-14** — SP#4 post-merge review tabled Q-02 recommendation (Option 2: cut Pro from MVP) based on updated burn-rate math. Awaiting user sign-off before SP#5 brainstorming opens.
- **2026-04-15** — Q-02 RESOLVED. User confirmed Option 2 (Pro cut from MVP). Free tier ships W4; Pro deferred to month 3 / SP#6 under Q-03. SP#5 brainstorming opens with Pro-cut as a precondition.
