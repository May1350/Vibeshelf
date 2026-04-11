# VibeShelf — Open Questions (parking lot)

**Created:** 2026-04-11 after Foundation brainstorming two-reviewer pass.
**Purpose:** Decisions surfaced during Foundation brainstorming but deliberately not resolved yet. Re-open at the named trigger point — not before (to avoid premature commitments) and not after (to avoid forgetting).

## How to use this file

- **Do NOT resolve items here.** This is a parking lot, not a decision log. Resolution happens in the relevant sub-project's brainstorming session.
- When you reach an item's "Re-open when" trigger, move the discussion into that session, decide, and **delete the item from this file** (or move it to a `resolved-questions.md` if you want an audit trail).
- New open questions surfaced during future brainstorming sessions should be appended here.

---

## Q-01. Automated demo screenshot capture (PRD §5.1 priority 3)

**Status:** Deferred from Foundation. Schema supports it; implementation does not exist.

**Background:** PRD §5.1 specifies a 4-tier preview priority where tier 3 is "데모 URL 감지 시 Puppeteer로 자동 스크린샷 생성". Foundation brainstorming chose to ship MVP with tiers 1, 2, and 4 only (README-embedded media + AI text fallback) because:
- Adding headless browser execution on day one would immediately trigger rule #2 of `future-separation-plan.md`, undermining the "single Next.js app" decision.
- Well-curated GitHub templates (the ones our scoring rewards) typically have README media already — priority 3 covers an estimated 10-15% edge case.
- Adding this post-MVP is ~2-3 days of work because schema already supports it.

**What's reserved in Foundation:**
- `asset_kind` enum includes `'demo_screenshot'` as a valid value (unused in MVP).
- `repo_assets` columns `storage_key`, `external_url`, `source_url`, `content_type`, `width`, `height` accept captured images whenever implementation lands.

**Open sub-questions (when implementation is decided):**
1. External API (ScreenshotOne, Urlbox, Apiflash, Microlink) vs Vercel Sandbox vs never.
2. Re-capture cadence: tied to the monthly re-score cycle? event-driven on repo update? manual only?
3. Failure handling: if capture fails for a repo, does it still publish (with "프리뷰 없음" badge) or stay unpublished?
4. Cost monitoring: if external API is chosen, budget alerting and per-repo cost cap.
5. Stale capture detection: how do we notice when a captured screenshot no longer matches the current demo?

**Re-open when:** Starting sub-project #2 (ingestion) or #3 (evaluation) brainstorming. Additionally, if post-launch analytics show ≥15% of published repos would benefit from automated capture (user CTR gap between repos with and without preview media, or explicit user complaints).

**Triggering this item also means reopening `future-separation-plan.md`** — trigger #2 (headless Chrome) activates the moment this is implemented.

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

## Q-04. Mutable data re-fetch / re-score policy

**Status:** Deferred. PRD §4.1 specifies re-score cadence but operational details are missing.

**Background:** The ingestion pipeline needs concrete answers for:
1. **README content drift:** Did the README text change? We store `readme_sha` — who computes and compares it? On what schedule?
2. **Metric drift:** Stars/forks/watchers update continuously. Do we store historical points in `repo_scores.raw_response.metrics_snapshot`, or only keep current?
3. **Repo rename/transfer:** GitHub allows renaming owner/name. What's our detection signal and update path? Do fork events and reviews migrate cleanly?
4. **Repo deleted/archived:** Retention policy for `reviews`, `fork_events`, `repo_assets` when parent repo transitions to `removed` status.
5. **License change mid-curation:** A permissive repo relicensed to GPL — do we auto-remove, flag for manual review, or grandfather?

**Re-open when:** Starting sub-project #2 (ingestion) brainstorming.

---

## Q-05. Gemini scoring throughput realism

**Status:** Deferred to sub-project #3.

**Background:** Reviewer R2 flagged that PRD §4.2's economics focus is the wrong lens. The real bottleneck isn't cost ($0.05 for 2,000 repos) but:
- Wall-clock time and retries on slow/failing calls
- Malformed or binary READMEs that break the scoring prompt
- Missing or broken demo URLs
- The promised 20% manual review queue (PRD §4.3) and its tooling

Foundation has one lever for this: `repo_scores` is append-only with `scoring_prompt_version` pinning, so A/B testing prompts without corrupting history is possible. Everything else is sub-project #3's problem.

**Open sub-questions:**
1. Concurrency model: N scoring workers via WDK fan-out? Global rate limit on Gemini quota?
2. Malformed README handling: truncate at N chars? Binary fallback to metadata-only scoring? Skip and flag for manual?
3. Manual review queue UI: where does the 20% manual review actually happen in MVP? (Admin dashboard? Spreadsheet export? Linear tickets? GitHub issues labelled `manual-review`?)
4. Prompt version rollout: how do we deploy a new `scoring_prompt_version` — score new repos only, or re-score all? How do we compare A/B?

**Re-open when:** Starting sub-project #3 brainstorming.

---

## Q-06. Observability, alerting, and SLO baseline

**Status:** Partially addressed in Foundation. Observability primitives exist; alerting policy does not.

**Background:** Foundation ships the `pipeline_runs` table, OTel trace emission from every `runJob()` wrapper, and log drain to Vercel Observability. But the following operational questions are unanswered:

1. **Failure alerting:** What fires when `pipeline_runs.status = 'failed'` exceeds a threshold? Vercel incidents? Slack webhook? Email? Nothing for MVP (check manually)?
2. **Freshness SLO:** "Repos should be scored within N hours of discovery" — what's N? How do we measure?
3. **Cost dashboard:** How do we notice if Gemini bill spikes? Pre-commit manual calculation? Vercel spend alert? Gemini API console check?
4. **Security alerting:** RLS policy violation attempts, failed SECURITY DEFINER function calls, suspicious token_validated_at patterns — where do these land?

**Re-open when:** Starting sub-project #3 brainstorming OR before first production launch, whichever comes first.

---

## Revision log

- **2026-04-11** — File created during Foundation brainstorming two-reviewer pass. Seeded with Q-01 through Q-06.
