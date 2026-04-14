---
title: VibeShelf Evaluation + Classification — Design Spec
date: 2026-04-14
status: draft (pending user approval)
sub_project: 03-evaluation-classification
parent_prd: VibeShelf_PRD_Final.md
related_docs:
  - docs/superpowers/specs/2026-04-11-foundation-design.md
  - docs/architecture/future-separation-plan.md
  - docs/architecture/open-questions.md
prior_sub_projects:
  - PR #1 (Foundation) merged 2026-04-13
  - PR #2 (Ingestion Pipeline) merged 2026-04-14
---

# VibeShelf Evaluation + Classification — Design Spec

**Sub-project #3 of 6.** Builds on Foundation + Ingestion Pipeline.

Purpose: score + classify `status='pending'` repos via Gemini Flash-Lite, publish qualifying repos to the marketplace, and support iteration via versioned prompts and monthly re-scoring.

---

## 0. Scope

**In scope:**
- Automated scoring (5 axes, weighted total_score)
- Automated category + feature-tag classification
- Auto-publish with gate (`visual_preview >= 2 AND total_score >= 2.5`) OR `status='needs_review'`
- Monthly re-scoring with prompt-version migration + grandfather policy

**Out of scope (deferred):**
- Manual review queue UI (Q-05.3 — MVP uses `supabase/snippets/` + Supabase Studio)
- Alerting/dashboards beyond `pipeline_runs` writes (Q-06 deferred)
- Advisory-lock fix in Foundation (issue #4 — status-claim pattern side-steps it here)

---

## 1. Data flow

```
┌────────────────────────┐
│ ingest-discover        │ daily 03:00 UTC (exists)
│ → status='pending'     │
└──────────┬─────────────┘
           │
           ▼ 30min later
┌────────────────────────┐
│ ingest-score           │ daily 03:30 UTC (NEW)
│ 1. Reset stuck rows    │   UPDATE WHERE status='scoring' AND updated_at < now()-15min → 'pending'
│ 2. Claim pending batch │   UPDATE ... SET status='scoring' FOR UPDATE SKIP LOCKED RETURNING
│ 3. For each claimed:   │
│    a. Load README      │
│    b. Compute det.     │   popularity, maintenance, code_health, visual_preview (DB-side)
│    c. Call Gemini      │   documentation + code_health(readme) + category + tags
│    d. apply_score_result RPC (atomic: INSERT score, UPSERT tags, UPDATE repo)
│ 4. Metrics → pipeline_runs
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ status = 'published'   │ (auto if gate passed)
│          'needs_review'│ (weak evidence OR content filter)
│          'scored'      │ (gate failed, awaiting manual promote)
└────────────────────────┘

┌────────────────────────┐
│ ingest-rescore         │ monthly 2nd 03:00 UTC (NEW)
│ - Select repos where stored version != current                 
│   OR scored_at < now() - 30 days
│ - Same per-repo flow, is_rescore=true
│ - Grandfather: published repos stay published if they drop     
│   below gate on rescore (grandfathered_at stamp)
│ - RESCORE_DRAIN_MODE env flag: forces daily cadence during     
│   major version migration
└────────────────────────┘

┌────────────────────────┐
│ pipeline-prune         │ weekly Sun 05:00 UTC (NEW)
│ - DELETE FROM pipeline_runs                                    
│   WHERE started_at < now() - 90 days AND status='success'     
│ - Failed runs retained indefinitely for postmortem            
└────────────────────────┘
```

### Cron schedule (vercel.json additions)

```json
{ "path": "/api/cron/score",   "schedule": "30 3 * * *" },
{ "path": "/api/cron/rescore", "schedule": "0 3 2 * *" },
{ "path": "/api/cron/prune",   "schedule": "0 5 * * 0" }
```

---

## 2. Gemini prompt design

### 2.1 Rubric split

**LLM computes (2 axes):**
| Axis | Weight | Source |
|------|--------|--------|
| documentation | 20% | README structure quality, setup guide, screenshots mentions |
| code_health (README-inferred) | 10% | test mentions, code example quality, build instructions |

**Deterministic (4 axes, DB-computed):**
| Axis | Weight | Formula |
|------|--------|---------|
| popularity | 15% | `min(5, log(stars+1) / log(months_since_created+2) × scale)` with log-cap |
| maintenance | 20% | `last_commit` freshness (6mo=5, 12mo=3, 24mo=1) + release count (future) |
| code_health (deterministic) | 15% | `has_tests` (file tree) + dep count/freshness (package.json) |
| visual_preview | 20% | repo_assets count × kind mix (GIF weighted > image > none) |

**Total** = generated column (STORED): `doc*0.20 + code_health*0.25 + maintenance*0.20 + popularity*0.15 + visual_preview*0.20`

**Note:** `code_health_score` column stores `(deterministic_portion * 0.6 + llm_portion * 0.4)` — both halves merged into one column for backward compatibility with existing schema. Weights sum to 1.00.

### 2.2 Prompt

**System prompt (Korean):**

> 당신은 오픈소스 GitHub 리포의 품질을 평가하는 큐레이터입니다.
> 바이브코더(비개발자 + Cursor/Lovable/Bolt 유저)가 이 템플릿을 자기 프로젝트에
> 써도 될지 판단하는 것이 목적입니다.

**User prompt includes:**
- Repo metadata (name, description, stars, last_commit_at, license)
- Detected tech_stack + vibecoding_tool slugs (pre-filled)
- `has_readme`, `has_package_json` flags
- **Structured README extraction** — Features / Getting Started / Usage / Tech Stack sections only (via markdown heading parse; fallback to first 8000 chars if no headings)
- Seed feature-tag enum (30 canonical slugs)
- Category enum (12 values: 8 existing + portfolio, blog, chatbot, mobile_app)

**responseSchema (order: value before rationale per axis):**

```json
{
  "type": "object",
  "properties": {
    "documentation": {
      "value": { "type": "integer", "minimum": 1, "maximum": 5 },
      "rationale": { "type": "string" }
    },
    "code_health_readme": { "value": "...", "rationale": "..." },
    "category": { "type": "string", "enum": [...12 categories...] },
    "feature_tags_canonical": {
      "type": "array",
      "items": { "type": "string", "enum": [...30 seed slugs...] }
    },
    "feature_tags_novel": { "type": "array", "items": { "type": "string" } },
    "evidence_strength": { "type": "string", "enum": ["strong","partial","weak"] }
  }
}
```

**Why integer 1-5 (not 0.5 increments):** Flash-Lite unreliably distinguishes 3.5 vs 4.0.
**Why `value` before `rationale`:** Schema field order affects generation — number conditioned on rationale prose becomes post-hoc justification otherwise.
**Why 30-seed enum:** Without it, LLM emits `auth`/`authentication`/`user_auth` inconsistently → filter UI breaks.

### 2.3 Schema retry

On JSON schema validation failure, retry ONCE with explicit error message appended:

```
Previous response failed schema: {validator.errors}. 
Regenerate strict JSON matching the provided schema exactly.
```

If second attempt also fails: `skipped='schema_error'`, repo stays `'pending'` for next cron.

### 2.4 `has_readme=false` path

Call Gemini with metadata-only prompt (description + topics + tech_stack). Results:
- `documentation_score = 0`
- `evidence_strength = 'weak'`
- Category + tags attempted from metadata only
- Usually gated to `scored` (documentation axis 0 pulls total below 2.5)

### 2.5 README fetch

Read from GitHub API at score time (no caching in MVP). Each score = 1 GitHub API call. At 20-50 new repos/day × 1 call, GitHub token pool budget fine. Re-scoring fetches again (readme_sha comparison is in refresh.ts, NOT score.ts).

---

## 3. Schema changes

### Migration 1: `20260415000001_evaluation_schema.sql`

```sql
-- Safety: ensure repo_scores is empty before destructive schema change
DO $$ 
BEGIN 
  IF EXISTS (SELECT 1 FROM public.repo_scores LIMIT 1) THEN 
    RAISE EXCEPTION 'repo_scores not empty; migration requires empty table'; 
  END IF; 
END $$;

-- Drop unused axis
ALTER TABLE public.repo_scores DROP COLUMN vibecoding_compat_score;

-- Add new axes
ALTER TABLE public.repo_scores 
  ADD COLUMN visual_preview_score numeric(3,2) NOT NULL DEFAULT 0 
    CHECK (visual_preview_score BETWEEN 0 AND 5),
  ADD COLUMN evidence_strength text,  -- enum added in migration 2
  ADD COLUMN rationale jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN run_id uuid REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  ADD COLUMN grandfathered_at timestamptz;

-- Replace total_score with generated column
ALTER TABLE public.repo_scores DROP COLUMN total_score;
ALTER TABLE public.repo_scores ADD COLUMN total_score numeric(3,2) 
  GENERATED ALWAYS AS (
    documentation_score      * 0.20 +
    code_health_score        * 0.25 +
    maintenance_score        * 0.20 +
    popularity_score         * 0.15 +
    visual_preview_score     * 0.20
  ) STORED;

-- Track whether asset extraction was attempted (visual_preview gating uses this)
ALTER TABLE public.repos ADD COLUMN assets_extracted_at timestamptz;
```

### Migration 2: `20260415000002_evidence_strength_type.sql`

```sql
CREATE TYPE public.evidence_strength AS ENUM ('strong','partial','weak');
ALTER TABLE public.repo_scores 
  ALTER COLUMN evidence_strength TYPE public.evidence_strength 
  USING evidence_strength::public.evidence_strength;
```

### Migration 3: `20260415000003_tags_freeform.sql`

```sql
ALTER TABLE public.repos 
  ADD COLUMN tags_freeform text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT tags_freeform_size_cap 
    CHECK (array_length(tags_freeform, 1) IS NULL OR array_length(tags_freeform, 1) <= 20);
COMMENT ON COLUMN public.repos.tags_freeform IS 
  'LLM-emitted feature tag slugs NOT in the canonical seed enum. Monitoring-only; NOT used by filter UI.';
CREATE INDEX idx_repos_tags_freeform_gin ON public.repos USING gin (tags_freeform);
```

### Migration 4: `20260415000004_seed_feature_tags.sql`

Insert 30 canonical feature-tag rows. See `lib/pipeline/scoring/seed-feature-tags.ts` for the authoritative source-of-truth constant (used in prompt + validation). Migration mirrors same list with `ON CONFLICT (slug) DO UPDATE SET kind='feature', label=EXCLUDED.label WHERE tags.kind <> 'feature'`.

Seed list (30 slugs):
```
auth, social_login, magic_link,
payments, stripe, subscription,
dark_mode, responsive, animation,
ai_integration, chatbot, rag,
database_included, realtime,
docker, ci_cd, self_hostable,
mdx, cms, blog_content,
email, transactional_email,
analytics, seo, sitemap,
i18n, rtl,
file_upload, search, notifications
```

### Migration 5: `20260415000005_extend_enums.sql` (TYPE-only, no usage)

```sql
ALTER TYPE public.repo_category ADD VALUE 'portfolio';
ALTER TYPE public.repo_category ADD VALUE 'blog';
ALTER TYPE public.repo_category ADD VALUE 'chatbot';
ALTER TYPE public.repo_category ADD VALUE 'mobile_app';

ALTER TYPE public.repo_status ADD VALUE 'scoring';
ALTER TYPE public.repo_status ADD VALUE 'needs_review';
```

### Migration 6: `20260415000006_scoring_rpcs.sql`

```sql
-- Claim N pending repos atomically
CREATE FUNCTION public.claim_pending_repos(p_limit int) RETURNS TABLE (...) 
  LANGUAGE plpgsql SECURITY DEFINER AS $$ ... $$;

-- Apply a scoring result atomically (is_latest flip + score insert + tag upsert + status)
CREATE FUNCTION public.apply_score_result(
  p_repo_id uuid,
  p_scores jsonb,
  p_category public.repo_category,
  p_canonical_tags jsonb,
  p_freeform_tags text[],
  p_rationale jsonb,
  p_evidence_strength public.evidence_strength,
  p_prompt_version text,
  p_model text,
  p_run_id uuid,
  p_is_rescore boolean
) RETURNS void 
  LANGUAGE plpgsql SECURITY DEFINER AS $$ 
    -- 1. UPDATE previous is_latest=true → false (BEFORE insert to avoid partial index conflict)
    -- 2. INSERT new repo_scores with is_latest=true
    -- 3. UPSERT repo_tags for canonical tags (source='auto')
    -- 4. UPDATE repos: category, tags_freeform (cap 20 + normalize), status per gate
    -- 5. If p_is_rescore AND currently_published AND new_gate_fails → keep published, set grandfathered_at
  $$;

-- Reset stuck scoring rows (reaper)
CREATE FUNCTION public.reset_stuck_scoring_repos() RETURNS int 
  LANGUAGE sql SECURITY DEFINER AS $$
    WITH reset AS (
      UPDATE public.repos 
      SET status = 'pending' 
      WHERE status = 'scoring' AND updated_at < now() - interval '15 minutes'
      RETURNING id
    )
    SELECT count(*) FROM reset;
  $$;

-- Grant execute to service_role only
REVOKE ALL ON FUNCTION ... FROM public;
GRANT EXECUTE ON FUNCTION ... TO service_role;
```

### Migration 7: `20260415000007_pipeline_runs_child_invariant.sql`

```sql
ALTER TABLE public.pipeline_runs ADD CONSTRAINT pipeline_runs_child_has_repo_id 
  CHECK (parent_run_id IS NULL OR input ? 'repo_id');
```

Enforces: child runs (those spawned by `ctx.spawn`) MUST have `input.repo_id` set.

---

## 4. File structure

```
lib/pipeline/
├── extractors/
│   ├── readme-media.ts          (refactored: extract parseReadme helper)
│   └── readme-sections.ts       NEW (reuses parseReadme → section-based extract)
├── gemini/
│   ├── client.ts                NEW — Gemini SDK wrapper, validates GEMINI_API_KEY at instantiation
│   ├── errors.ts                NEW — RateLimitError, SchemaValidationError, ContentFilterError, ServerError
│   └── scoring-prompt.ts        NEW — buildScoringPrompt + responseSchema + SCORING_PROMPT_VERSION const
├── tags/
│   └── resolve.ts               NEW — upsertAndLinkTags (extracted from discover.ts, used by both)
├── scoring/
│   ├── seed-feature-tags.ts     NEW — SEED_FEATURE_TAG_SLUGS readonly string[]
│   ├── deterministic.ts         NEW — popularity/maintenance/code_health(det)/visual_preview calc
│   ├── request-budget.ts        NEW — kill-switch (maxCalls, maxCostUsd)
│   ├── tag-normalizer.ts        NEW — LLM output → {canonical: ...[], freeform: ...[]}
│   └── score-repo.ts            NEW — per-repo orchestration
├── metrics/
│   └── scoring-metrics.ts       NEW — ScoreJobMetrics interface + recordScoreMetrics helper
└── jobs/
    ├── score.ts                 NEW (daily)
    ├── rescore.ts               NEW (monthly)
    └── prune.ts                 NEW (weekly)

app/api/cron/
├── score/route.ts               NEW
├── rescore/route.ts             NEW
└── prune/route.ts               NEW

supabase/snippets/                NEW
├── pending-too-long.sql
├── gated-this-week.sql
├── rate-limit-hit.sql
├── scores-near-gate.sql
├── repo-timeline.sql
└── freeform-tag-frequency.sql

lib/env.ts — GEMINI_API_KEY stays .optional() (pipeline-scope; enforced at gemini/client.ts)
Add RESCORE_DRAIN_MODE: z.enum(['true','false']).optional()
```

### Dep-cruiser rule updates (none)

F3 carve-out (`^app/api/cron/[^/]+/route\.ts$`) already covers `score`, `rescore`, `prune` routes.

---

## 5. Execution model

### 5.1 score.ts per-run flow

```typescript
export async function scoreJob(ctx, input?) {
  // 1. Reset stuck 'scoring' rows (reaper)
  const resetCount = await ctx.db.rpc('reset_stuck_scoring_repos');
  
  // 2. Initialize budget (context-aware)
  const budget = new RequestBudget({
    maxCalls: input?.mode === 'rescore' ? 2000 : 500,
    maxCostUsd: 5.00
  });
  
  // 3. Claim batch atomically
  const { data: claimed } = await ctx.db.rpc('claim_pending_repos', { p_limit: batchSize });
  if (claimed.length === 0) return emptyOutput;
  
  // 4. Per-repo via ctx.spawn (child runs for observability)
  for (const repo of claimed) {
    if (!budget.canProceed()) break;
    try {
      await ctx.spawn('score-repo', { repo_id: repo.id, owner: repo.owner }, async (childCtx) => {
        return await scoreRepo(childCtx, repo, budget, { is_rescore: false });
      });
    } catch (err) {
      // RateLimitError halts the whole job; others become skips (status reverts to 'pending' next cron)
      if (err instanceof RateLimitError) throw err;
      await ctx.db.from('repos').update({ status: 'pending' }).eq('id', repo.id);
    }
  }
  
  // 5. Record structured metrics
  recordScoreMetrics(ctx, { ... });
}
```

### 5.2 scoreRepo (per-repo)

```typescript
async function scoreRepo(ctx, repo, budget, opts): Promise<ScoreOutcome> {
  const readme = await fetchReadme(ctx.db, repo.owner, repo.name);  // GitHub API
  const sections = extractReadmeSections(readme);
  
  const deterministic = computeDeterministicScores(repo, readme, repo.capabilities);
  
  const geminiResult = await geminiClient.score({
    repo, sections, tech_stack: repo.capabilities.tech_stack_slugs,
    vibecoding_tools: repo.capabilities.vibecoding_tools,
  }, budget);
  
  if (geminiResult.skipped) {
    if (geminiResult.skipped === 'content_filter') {
      // → status='needs_review' via apply_score_result
      await applyScoreResult(ctx, { ..., status_override: 'needs_review' });
      return { outcome: 'needs_review' };
    }
    // schema_error / server_error: revert to pending
    return { outcome: 'skipped' };
  }
  
  const { canonical, freeform } = normalizeTags(geminiResult.feature_tags_canonical, geminiResult.feature_tags_novel);
  
  await ctx.db.rpc('apply_score_result', {
    p_repo_id: repo.id,
    p_scores: { ...geminiResult.scores, ...deterministic },  // 6-axis merge
    p_category: geminiResult.category,
    p_canonical_tags: canonical,
    p_freeform_tags: freeform,
    p_rationale: geminiResult.rationale,
    p_evidence_strength: geminiResult.evidence_strength,
    p_prompt_version: SCORING_PROMPT_VERSION,
    p_model: 'gemini-flash-lite',
    p_run_id: ctx.runId,
    p_is_rescore: opts.is_rescore,
  });
  
  return { outcome: /* published | scored | needs_review */ };
}
```

### 5.3 Error taxonomy

| Error type | Repo state | Retry |
|---|---|---|
| `SchemaValidationError` | `'pending'` (reverted) | Next cron (2x inline retry with error re-injection, then give up) |
| `RateLimitError` (429) | Remaining batch reverts to `'pending'` | Exponential backoff 2x inline, then halt whole job |
| `ServerError` (5xx) | `'pending'` (reverted) | Next cron (2x inline retry with backoff) |
| `ContentFilterError` | `'needs_review'` (human looks) | Manual decision |
| README fetch fail | `'pending'` (reverted) | Next cron; after 3 consecutive fails, manual flag (deferred — separate followup issue) |

### 5.4 Publish gate

Inside `apply_score_result` RPC:

```
IF p_is_rescore AND current_status = 'published' AND new_total_score < 2.5 THEN
  -- Grandfather: keep published, stamp grandfathered_at
  UPDATE repos SET grandfathered_at = now() WHERE id = p_repo_id;
ELSIF p_evidence_strength = 'weak' OR new_total_score < 2.5 THEN
  UPDATE repos SET status = 'needs_review' ...;
ELSIF repos.assets_extracted_at IS NOT NULL AND new_visual_preview_score < 2 THEN
  UPDATE repos SET status = 'scored' ...;  -- gated
ELSE
  UPDATE repos SET status = 'published' ...;
END IF;
```

**Why `assets_extracted_at` check:** `visual_preview_score=0` could mean either "no media extraction attempted" (bug) or "attempted, found none" (real low). Only gate on the latter.

---

## 6. Observability

### 6.1 Metrics schema (TypeScript-enforced)

```typescript
// lib/pipeline/metrics/scoring-metrics.ts
export interface ScoreJobMetrics {
  repos_claimed: number;
  repos_scored: number;
  repos_published: number;
  repos_gated: number;
  repos_needs_review: number;
  repos_skipped_schema: number;
  repos_skipped_server_error: number;
  repos_stuck_reset: number;
  gemini_calls: number;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  gemini_429_count: number;
  cost_usd: number;
  budget_exhausted: boolean;
  avg_latency_ms: number;
}

export function recordScoreMetrics(ctx: JobContext, metrics: ScoreJobMetrics): void;
```

### 6.2 Per-repo traceability

Every `score-repo` child run has `input = { repo_id: <uuid>, owner: <string> }` — enforced by DB CHECK (`pipeline_runs_child_has_repo_id`). Operator queries via `WHERE input->>'repo_id' = '...'`.

### 6.3 Operator SQL snippets (`supabase/snippets/`)

- `pending-too-long.sql` — pending rows older than 3 days
- `gated-this-week.sql` — `status IN ('scored','needs_review')` transitions this week
- `rate-limit-hit.sql` — `pipeline_runs.metrics->>'gemini_429_count' > 0` this week
- `scores-near-gate.sql` — `total_score BETWEEN 2.3 AND 2.7` (candidates for manual review)
- `repo-timeline.sql` — full score history for a given repo_id
- `freeform-tag-frequency.sql` — `tags_freeform` across all repos, grouped by slug with count/first_seen/last_seen

CI validates each snippet: `supabase db execute --file $f --dry-run` (adds ~5s to db-integration job).

### 6.4 429 alerting policy

- `gemini_429_count = 0` → normal
- `> 5 in a single run` → log-level warning
- `> 20 in a single run` → error (likely quota exhaustion; operator must consider tier bump)

MVP: manual watch via Vercel function logs + snippet queries. No automated alerting (Q-06 deferred to Q-06 followup).

---

## 7. Testing

### 7.1 Unit (no DB, no network)

- `tests/unit/pipeline/scoring/deterministic.test.ts` — popularity/maintenance/code_health/visual_preview, including boundary cases (stars=0, months=0, very new repo with 1 star, very old repo with 10000 stars)
- `tests/unit/pipeline/scoring/seed-feature-tags.test.ts` — 30 slug validity (lowercase, snake_case), label format, no duplicates
- `tests/unit/pipeline/scoring/tag-normalizer.test.ts` — LLM output → canonical / freeform split, cap-20 enforcement, normalization (lowercase + non-alnum → `_`)
- `tests/unit/pipeline/scoring/request-budget.test.ts` — exhaustion detection
- `tests/unit/pipeline/gemini/scoring-prompt.test.ts` — buildScoringPrompt snapshot (stability), responseSchema shape
- `tests/unit/pipeline/gemini/errors.test.ts` — error classification from mocked Gemini responses
- `tests/unit/pipeline/extractors/readme-sections.test.ts` — section extraction, fallback to first-8000 when no headings

### 7.2 Integration (real Supabase)

- `tests/integration/pipeline/apply-score-result-rpc.test.ts` — atomicity: partial failure rolls back; is_latest invariant after sequential RPCs (one true); grandfather policy: published + sub-gate rescore keeps published + stamps grandfathered_at; first-time + sub-gate → needs_review (NOT grandfather)
- `tests/integration/pipeline/claim-pending-rpc.test.ts` — concurrent test via `pg` node client with two connections, verifies SKIP LOCKED actually skips locked rows
- `tests/integration/pipeline/reset-stuck-rpc.test.ts` — seeds rows with status='scoring' at various ages, verifies reaper resets exactly those >15min
- `tests/integration/pipeline/score-job.test.ts` — full flow with mocked Gemini: happy path → published; has_readme=false → metadata-only path; content_filter → needs_review; budget exhaustion halts loop
- `tests/integration/pipeline/rescore-job.test.ts` — prompt-version migration selects correct repos; grandfather behavior on published rescore
- `tests/integration/pipeline/prune-job.test.ts` — deletes success rows older than 90 days; retains failed rows
- `tests/integration/pipeline/cron-auth.test.ts` — already exists; extend to cover score/rescore/prune routes

### 7.3 Gemini mocking

- Factory: `createGeminiClient(fetchImpl?)` — default real fetch, test injects mock
- Fixtures: `tests/fixtures/gemini-responses/`
  - `happy.json` — complete valid response
  - `schema-bad.json` — missing required field
  - `schema-semantically-garbage.json` — valid shape, all scores 0, empty tags → should flag needs_review
  - `content-filter.json` — Gemini safety response
  - `rate-limit.json` — 429 status
  - `server-error.json` — 500 status
  - `json-truncated.json` — response cuts mid-object
- Fixture validity test: each fixture validates against current `responseSchema` at test time (catches drift when prompt version bumps)

### 7.4 Negative dep-cruiser fixture

- `lib/pipeline/jobs/__fixtures__/bad-score-service-import.ts` — attempts `import { createServiceClient } from '@/lib/db/service-client'`. Should trip F4 rule. Added to `lint:neg:depcruise` script.

---

## 8. Rescore details

### 8.1 Rescore trigger logic

```sql
-- Candidate selection
SELECT r.* FROM repos r 
JOIN repo_scores rs ON rs.repo_id = r.id AND rs.is_latest
WHERE r.status IN ('published','scored','needs_review')
  AND (
    rs.scoring_prompt_version != :current_version
    OR rs.scored_at < now() - interval '30 days'
  )
ORDER BY 
  CASE WHEN rs.scoring_prompt_version != :current_version THEN 0 ELSE 1 END,
  rs.scored_at ASC
LIMIT :batch_size;
```

Version mismatch prioritized over age. On major version bump, enables drain via `RESCORE_DRAIN_MODE=true`.

### 8.2 Version management

```typescript
// lib/pipeline/gemini/scoring-prompt.ts
export const SCORING_PROMPT_VERSION = '1.0.0';  // semver
```

- **patch (1.0.1)**: wording tweaks → selective rescore
- **minor (1.1.0)**: axis definition changes → full rescore
- **major (2.0.0)**: category/tag enum changes → full rescore + schema migration

### 8.3 RESCORE_DRAIN_MODE

When true:
- Rescore cron runs daily (instead of monthly) at 03:15 UTC
- Budget bumps to 2000/run (same as standard rescore)
- Operator monitors `freeform-tag-frequency.sql` + completion via count of version-mismatched rows
- Toggle back to false manually when drain completes (count < 100 pending mismatches)

---

## 9. Open questions

Resolved in this spec:
- **Q-05** (Gemini throughput) — RESOLVED here. Concurrency: sequential with per-call rate pacing. Malformed: 2x retry + skip. Manual review: `needs_review` status + supabase/snippets/ operator surface. Prompt versions: semver + rescore drain mode.

Still deferred:
- **Q-06** (Observability baseline) — Partially addressed via `ScoreJobMetrics` interface + 6 SQL snippets + `gemini_429_count` threshold, but automated alerting still deferred. Re-open before production launch.
- **Q-07** (Token pool ops) — No change from sub-project #2 state.
- **Q-08** (Cron route observability gap) — No change.

New followup:
- **Issue #4** — Foundation advisory lock ineffective (session-scoped over HTTP). Sub-project #3 side-steps via status-claim pattern, but discover/refresh/dormant still technically vulnerable. Low operational risk (upsert idempotency protects data), but should be documented and fixed long-term.

---

## 10. Dev checklist (manual, outside spec)

1. Set `GEMINI_API_KEY` in Vercel production + preview envs (`openssl rand` N/A — this is a real API key from Google AI Studio)
2. Set `GEMINI_API_KEY` in GitHub Actions secrets for CI (or use dummy value in `.env.test.local` since integration tests mock Gemini)
3. First launch: leave `RESCORE_DRAIN_MODE` unset (false). Toggle true only when a major prompt version bumps.
4. Monitor Vercel function logs weekly for `gemini_429_count` exceeding threshold.

---

## Revision log

- **2026-04-14** — File created during sub-project #3 brainstorming. Two-reviewer pass applied 14 critical+real findings. User approved all 5 sections (data flow, prompt, schema, execution, observability).
