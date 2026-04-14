# VibeShelf Evaluation + Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Co-reference:** `docs/superpowers/specs/2026-04-14-evaluation-classification-design.md` contains the full design, rationale, and reviewer findings. Read sections 2–9 of the spec before starting any task — do NOT guess or paraphrase.
>
> **Dependencies:** Foundation (PR #1) + Ingestion Pipeline (PR #2) MUST be merged to main. This plan extends existing `lib/pipeline/` and `supabase/migrations/`.

**Goal:** Add automated scoring + classification for `status='pending'` repos via Gemini Flash-Lite, with atomic writes, publish gating, and monthly re-scoring support.

**Architecture:** Single Gemini call per repo (responseSchema-enforced). 2 LLM-computed axes + 4 deterministic. Per-repo writes routed through `apply_score_result` SECURITY DEFINER RPC for atomicity. Status-claim pattern (`SELECT ... FOR UPDATE SKIP LOCKED`) replaces ineffective advisory locks. Append-only `repo_scores` with grandfather policy on rescore demotion.

**Tech Stack:** Next.js 16+, TypeScript, Supabase (PostgreSQL), Gemini Flash-Lite (`@google/genai` SDK), existing Foundation primitives (`runJob`, `lib/pipeline/github/client.ts`).

---

## File Map

### New files to create

```
supabase/
├── migrations/
│   ├── 20260415000001_evaluation_schema.sql
│   ├── 20260415000002_evidence_strength_type.sql
│   ├── 20260415000003_tags_freeform.sql
│   ├── 20260415000004_seed_feature_tags.sql
│   ├── 20260415000005_extend_enums.sql
│   ├── 20260415000006_scoring_rpcs.sql
│   └── 20260415000007_pipeline_runs_child_invariant.sql
└── snippets/
    ├── pending-too-long.sql
    ├── gated-this-week.sql
    ├── rate-limit-hit.sql
    ├── scores-near-gate.sql
    ├── repo-timeline.sql
    └── freeform-tag-frequency.sql

lib/pipeline/
├── extractors/
│   └── readme-sections.ts              NEW
├── gemini/
│   ├── client.ts                       NEW
│   ├── errors.ts                       NEW
│   └── scoring-prompt.ts               NEW
├── tags/
│   └── resolve.ts                      NEW
├── scoring/
│   ├── seed-feature-tags.ts            NEW
│   ├── deterministic.ts                NEW
│   ├── request-budget.ts               NEW
│   ├── tag-normalizer.ts               NEW
│   └── score-repo.ts                   NEW
├── metrics/
│   └── scoring-metrics.ts              NEW
├── jobs/
│   ├── score.ts                        NEW
│   ├── rescore.ts                      NEW
│   └── prune.ts                        NEW
└── jobs/__fixtures__/
    └── bad-score-service-import.ts     NEW (negative fixture)

app/api/cron/
├── score/route.ts                      NEW
├── rescore/route.ts                    NEW
└── prune/route.ts                      NEW

tests/
├── unit/pipeline/
│   ├── scoring/
│   │   ├── deterministic.test.ts       NEW
│   │   ├── seed-feature-tags.test.ts   NEW
│   │   ├── tag-normalizer.test.ts      NEW
│   │   └── request-budget.test.ts      NEW
│   ├── gemini/
│   │   ├── scoring-prompt.test.ts      NEW
│   │   └── errors.test.ts              NEW
│   └── extractors/
│       └── readme-sections.test.ts     NEW
├── integration/pipeline/
│   ├── apply-score-result-rpc.test.ts  NEW
│   ├── claim-pending-rpc.test.ts       NEW
│   ├── reset-stuck-rpc.test.ts         NEW
│   ├── score-job.test.ts               NEW
│   ├── rescore-job.test.ts             NEW
│   └── prune-job.test.ts               NEW
└── fixtures/gemini-responses/
    ├── happy.json                      NEW
    ├── schema-bad.json                 NEW
    ├── schema-semantic-garbage.json    NEW
    ├── content-filter.json             NEW
    ├── rate-limit.json                 NEW
    ├── server-error.json               NEW
    └── json-truncated.json             NEW
```

### Files to modify

```
lib/env.ts                              (add RESCORE_DRAIN_MODE)
lib/pipeline/extractors/readme-media.ts (refactor: export parseReadme)
lib/pipeline/jobs/discover.ts           (refactor: use tags/resolve.ts)
vercel.json                             (add 3 cron schedules)
package.json                            (add @google/genai)
.github/workflows/ci.yml                (add snippet validation step)
docs/architecture/open-questions.md     (mark Q-05 resolved)
```

---

## Task 1 — Schema migrations (batch)

**Dependencies:** None (Foundation + Ingestion already merged)

**Files:**
- Create: `supabase/migrations/20260415000001_evaluation_schema.sql`
- Create: `supabase/migrations/20260415000002_evidence_strength_type.sql`
- Create: `supabase/migrations/20260415000003_tags_freeform.sql`
- Create: `supabase/migrations/20260415000004_seed_feature_tags.sql`
- Create: `supabase/migrations/20260415000005_extend_enums.sql`
- Create: `supabase/migrations/20260415000007_pipeline_runs_child_invariant.sql`

### Migration 1: evaluation_schema.sql

- [ ] **Step 1.1:** Create `supabase/migrations/20260415000001_evaluation_schema.sql`:

```sql
-- Safety: ensure repo_scores is empty before destructive schema change.
-- repo_scores is APPEND-ONLY; if any row exists we cannot safely rewrite
-- total_score as a GENERATED column.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.repo_scores LIMIT 1) THEN
    RAISE EXCEPTION 'repo_scores not empty; migration requires empty table';
  END IF;
END $$;

-- Drop unused vibecoding_compat axis (reviewer consensus: deterministic
-- signal from capabilities jsonb is better than asking LLM to re-assess).
ALTER TABLE public.repo_scores DROP COLUMN vibecoding_compat_score;

-- Add new axes + metadata columns
ALTER TABLE public.repo_scores
  ADD COLUMN visual_preview_score numeric(3,2) NOT NULL DEFAULT 0
    CHECK (visual_preview_score BETWEEN 0 AND 5),
  ADD COLUMN evidence_strength text,
  ADD COLUMN rationale jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN run_id uuid REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  ADD COLUMN grandfathered_at timestamptz;

-- Replace total_score with 5-axis weighted generated column
ALTER TABLE public.repo_scores DROP COLUMN total_score;
ALTER TABLE public.repo_scores ADD COLUMN total_score numeric(3,2)
  GENERATED ALWAYS AS (
    documentation_score     * 0.20 +
    code_health_score       * 0.25 +
    maintenance_score       * 0.20 +
    popularity_score        * 0.15 +
    visual_preview_score    * 0.20
  ) STORED;

-- Track whether asset extraction was attempted (visual_preview gating uses this
-- to distinguish "no extraction attempted" (bug) from "attempted, found none").
ALTER TABLE public.repos ADD COLUMN assets_extracted_at timestamptz;
```

### Migration 2: evidence_strength_type.sql

- [ ] **Step 1.2:** Create `supabase/migrations/20260415000002_evidence_strength_type.sql`:

```sql
CREATE TYPE public.evidence_strength AS ENUM ('strong', 'partial', 'weak');

ALTER TABLE public.repo_scores
  ALTER COLUMN evidence_strength TYPE public.evidence_strength
  USING evidence_strength::public.evidence_strength;
```

### Migration 3: tags_freeform.sql

- [ ] **Step 1.3:** Create `supabase/migrations/20260415000003_tags_freeform.sql`:

```sql
ALTER TABLE public.repos
  ADD COLUMN tags_freeform text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT tags_freeform_size_cap
    CHECK (array_length(tags_freeform, 1) IS NULL OR array_length(tags_freeform, 1) <= 20);

COMMENT ON COLUMN public.repos.tags_freeform IS
  'LLM-emitted feature tag slugs NOT in canonical seed enum. Monitoring only; NOT used by filter UI. See supabase/snippets/freeform-tag-frequency.sql for analysis.';

CREATE INDEX idx_repos_tags_freeform_gin ON public.repos USING gin (tags_freeform);
```

### Migration 4: seed_feature_tags.sql

- [ ] **Step 1.4:** Create `supabase/migrations/20260415000004_seed_feature_tags.sql`:

```sql
-- Seed the canonical 30-slug feature tag enum. Source of truth in
-- lib/pipeline/scoring/seed-feature-tags.ts — keep in sync.
--
-- ON CONFLICT ... DO UPDATE handles the edge case where sub-project #2's
-- discover job may have inserted one of these slugs with kind='tech_stack'.
-- This migration promotes them to kind='feature' if they were wrong-kinded.

INSERT INTO public.tags (slug, kind, label) VALUES
  ('auth',                  'feature', 'Authentication'),
  ('social_login',          'feature', 'Social Login'),
  ('magic_link',            'feature', 'Magic Link'),
  ('payments',              'feature', 'Payments'),
  ('stripe',                'feature', 'Stripe'),
  ('subscription',          'feature', 'Subscription'),
  ('dark_mode',             'feature', 'Dark Mode'),
  ('responsive',            'feature', 'Responsive'),
  ('animation',             'feature', 'Animation'),
  ('ai_integration',        'feature', 'AI Integration'),
  ('chatbot',               'feature', 'Chatbot'),
  ('rag',                   'feature', 'RAG'),
  ('database_included',     'feature', 'Database Included'),
  ('realtime',              'feature', 'Realtime'),
  ('docker',                'feature', 'Docker'),
  ('ci_cd',                 'feature', 'CI/CD'),
  ('self_hostable',         'feature', 'Self-hostable'),
  ('mdx',                   'feature', 'MDX'),
  ('cms',                   'feature', 'CMS'),
  ('blog_content',          'feature', 'Blog Content'),
  ('email',                 'feature', 'Email'),
  ('transactional_email',   'feature', 'Transactional Email'),
  ('analytics',             'feature', 'Analytics'),
  ('seo',                   'feature', 'SEO'),
  ('sitemap',               'feature', 'Sitemap'),
  ('i18n',                  'feature', 'i18n'),
  ('rtl',                   'feature', 'RTL'),
  ('file_upload',           'feature', 'File Upload'),
  ('search',                'feature', 'Search'),
  ('notifications',         'feature', 'Notifications')
ON CONFLICT (slug) DO UPDATE
  SET kind = 'feature', label = EXCLUDED.label
  WHERE public.tags.kind <> 'feature';
```

### Migration 5: extend_enums.sql

- [ ] **Step 1.5:** Create `supabase/migrations/20260415000005_extend_enums.sql` — TYPE-only, no usage in same file:

```sql
-- repo_category: 4 new values
ALTER TYPE public.repo_category ADD VALUE 'portfolio';
ALTER TYPE public.repo_category ADD VALUE 'blog';
ALTER TYPE public.repo_category ADD VALUE 'chatbot';
ALTER TYPE public.repo_category ADD VALUE 'mobile_app';

-- repo_status: 2 new values ('scoring' intermediate state for claim pattern, 'needs_review' for weak evidence/content filter)
ALTER TYPE public.repo_status ADD VALUE 'scoring';
ALTER TYPE public.repo_status ADD VALUE 'needs_review';

-- repo_tags.source: add 'auto_llm' to distinguish LLM-inferred from rule-based 'auto'
ALTER TABLE public.repo_tags DROP CONSTRAINT IF EXISTS repo_tags_source_check;
ALTER TABLE public.repo_tags ADD CONSTRAINT repo_tags_source_check
  CHECK (source IN ('ai', 'manual', 'review_derived', 'auto', 'auto_llm'));
```

### Migration 7: pipeline_runs_child_invariant.sql

(Migration 6 — scoring_rpcs — comes in Task 2; it depends on enum values from Migration 5 being committed.)

- [ ] **Step 1.6:** Create `supabase/migrations/20260415000007_pipeline_runs_child_invariant.sql`:

```sql
-- Child runs (those with parent_run_id set) MUST carry repo_id in input
-- for per-repo traceability (see spec §6.2 — operator queries).
ALTER TABLE public.pipeline_runs
  ADD CONSTRAINT pipeline_runs_child_has_repo_id
    CHECK (parent_run_id IS NULL OR input ? 'repo_id');
```

- [ ] **Step 1.7:** Verify all 6 migration files apply cleanly locally:

```bash
supabase db reset --no-seed
```

Expected: no errors, migrations apply in order.

- [ ] **Step 1.8:** Commit:

```bash
git add supabase/migrations/20260415*.sql
git commit -m "feat(db): evaluation schema + enums + tags_freeform (migrations 1-5, 7)"
```

---

## Task 2 — Scoring RPCs (migration 6)

**Dependencies:** Task 1 (enum values committed)

**Files:**
- Create: `supabase/migrations/20260415000006_scoring_rpcs.sql`

This migration is split because it uses `evidence_strength` enum + new `repo_status` values from Task 1; Postgres requires them to be committed before use.

- [ ] **Step 2.1:** Create `supabase/migrations/20260415000006_scoring_rpcs.sql`:

```sql
-- ══════════════════════════════════════════════════════════════════════
-- claim_pending_repos
--   Atomically claim up to p_limit 'pending' repos, transition them to
--   'scoring', and return the claimed rows. Uses FOR UPDATE SKIP LOCKED
--   so concurrent cron invocations never claim the same row twice.
--   Replaces the ineffective advisory-lock pattern (Foundation issue #4).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.claim_pending_repos(p_limit int)
RETURNS TABLE (
  id                 uuid,
  github_id          bigint,
  owner              text,
  name               text,
  description        text,
  homepage           text,
  license            text,
  default_branch    text,
  stars              int,
  forks              int,
  watchers           int,
  last_commit_at     timestamptz,
  github_created_at  timestamptz,
  github_pushed_at   timestamptz,
  readme_sha         text,
  capabilities       jsonb,
  assets_extracted_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.repos r
    SET status = 'scoring'
    WHERE r.id IN (
      SELECT r2.id FROM public.repos r2
      WHERE r2.status = 'pending'
      ORDER BY r2.updated_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    )
    RETURNING r.id
  )
  SELECT r.id, r.github_id, r.owner, r.name, r.description, r.homepage,
         r.license, r.default_branch, r.stars, r.forks, r.watchers,
         r.last_commit_at, r.github_created_at, r.github_pushed_at,
         r.readme_sha, r.capabilities, r.assets_extracted_at
  FROM public.repos r
  JOIN claimed c ON c.id = r.id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_repos(int) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_pending_repos(int) TO service_role;

-- ══════════════════════════════════════════════════════════════════════
-- reset_stuck_scoring_repos
--   Reaper: reset rows stuck in 'scoring' for >15 minutes back to
--   'pending'. Called at the start of every score job to recover from
--   Vercel timeout / crash mid-flight. Returns count of rows reset.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.reset_stuck_scoring_repos()
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH reset AS (
    UPDATE public.repos
    SET status = 'pending'
    WHERE status = 'scoring'
      AND updated_at < now() - interval '15 minutes'
    RETURNING id
  )
  SELECT count(*)::int FROM reset;
$$;

REVOKE ALL ON FUNCTION public.reset_stuck_scoring_repos() FROM public;
GRANT EXECUTE ON FUNCTION public.reset_stuck_scoring_repos() TO service_role;

-- ══════════════════════════════════════════════════════════════════════
-- apply_score_result
--   Atomically: flip prior is_latest, insert new repo_scores, upsert
--   repo_tags, update repos (category, tags_freeform, status-per-gate).
--   Grandfathered when p_is_rescore=true AND repos.status='published'
--   AND new total_score < 2.5.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.apply_score_result(
  p_repo_id               uuid,
  p_documentation_score   numeric(3,2),
  p_code_health_score     numeric(3,2),
  p_maintenance_score     numeric(3,2),
  p_popularity_score      numeric(3,2),
  p_visual_preview_score  numeric(3,2),
  p_category              public.repo_category,
  p_canonical_tag_ids     uuid[],
  p_canonical_confidences numeric[],
  p_freeform_tags         text[],
  p_rationale             jsonb,
  p_evidence_strength     public.evidence_strength,
  p_prompt_version        text,
  p_model                 text,
  p_run_id                uuid,
  p_is_rescore            boolean
)
RETURNS public.repo_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_total          numeric(3,2);
  v_current_status     public.repo_status;
  v_assets_extracted   timestamptz;
  v_next_status        public.repo_status;
  v_tag_id             uuid;
  v_idx                int;
BEGIN
  -- Step 1: compute new total (mirrors the GENERATED column formula)
  v_new_total :=
    p_documentation_score  * 0.20 +
    p_code_health_score    * 0.25 +
    p_maintenance_score    * 0.20 +
    p_popularity_score     * 0.15 +
    p_visual_preview_score * 0.20;

  -- Step 2: read current repo state (status + assets_extracted_at for gate)
  SELECT status, assets_extracted_at INTO v_current_status, v_assets_extracted
  FROM public.repos WHERE id = p_repo_id FOR UPDATE;

  -- Step 3: flip prior is_latest=false BEFORE inserting new row
  -- (avoids partial unique index violation on idx_repo_scores_one_latest_per_repo)
  UPDATE public.repo_scores
  SET is_latest = false
  WHERE repo_id = p_repo_id AND is_latest = true;

  -- Step 4: insert new repo_scores row
  INSERT INTO public.repo_scores (
    repo_id, documentation_score, maintenance_score, popularity_score,
    code_health_score, vibecoding_compat_score, visual_preview_score,
    scoring_model, scoring_prompt_version, raw_response, rationale,
    evidence_strength, run_id, is_latest
  ) VALUES (
    p_repo_id, p_documentation_score, p_maintenance_score, p_popularity_score,
    p_code_health_score, 0, p_visual_preview_score,
    p_model, p_prompt_version, '{}'::jsonb, p_rationale,
    p_evidence_strength, p_run_id, true
  );

  -- Step 5: upsert canonical repo_tags
  IF array_length(p_canonical_tag_ids, 1) IS NOT NULL THEN
    FOR v_idx IN 1..array_length(p_canonical_tag_ids, 1) LOOP
      INSERT INTO public.repo_tags (repo_id, tag_id, confidence, source)
      VALUES (p_repo_id, p_canonical_tag_ids[v_idx], p_canonical_confidences[v_idx], 'auto_llm')
      ON CONFLICT (repo_id, tag_id) DO UPDATE
        SET confidence = EXCLUDED.confidence, source = 'auto_llm';
    END LOOP;
  END IF;

  -- Step 6: determine next status (publish gate + grandfather)
  IF p_is_rescore AND v_current_status = 'published' AND v_new_total < 2.5 THEN
    v_next_status := 'published';  -- grandfather
    UPDATE public.repos
    SET grandfathered_at = now(), tags_freeform = p_freeform_tags, category = p_category
    WHERE id = p_repo_id;
  ELSIF p_evidence_strength = 'weak' OR v_new_total < 2.5 THEN
    v_next_status := 'needs_review';
  ELSIF v_assets_extracted IS NOT NULL AND p_visual_preview_score < 2 THEN
    v_next_status := 'scored';  -- gated on preview
  ELSE
    v_next_status := 'published';
  END IF;

  -- Step 7: update repos with new status + category + tags_freeform
  UPDATE public.repos
  SET status        = v_next_status,
      category      = p_category,
      tags_freeform = p_freeform_tags
  WHERE id = p_repo_id;

  RETURN v_next_status;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_score_result(uuid, numeric, numeric, numeric, numeric, numeric, public.repo_category, uuid[], numeric[], text[], jsonb, public.evidence_strength, text, text, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.apply_score_result(uuid, numeric, numeric, numeric, numeric, numeric, public.repo_category, uuid[], numeric[], text[], jsonb, public.evidence_strength, text, text, uuid, boolean) TO service_role;
```

- [ ] **Step 2.2:** Apply locally:

```bash
supabase db reset --no-seed
```

- [ ] **Step 2.3:** Commit:

```bash
git add supabase/migrations/20260415000006_scoring_rpcs.sql
git commit -m "feat(db): scoring RPCs (claim_pending, reset_stuck, apply_score_result)"
```

---

## Task 3 — Install Gemini SDK + env updates

**Files:**
- Modify: `package.json`
- Modify: `lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 3.1:** Install Gemini SDK:

```bash
pnpm add @google/genai
```

Expected: `@google/genai` in `dependencies`.

- [ ] **Step 3.2:** Add `RESCORE_DRAIN_MODE` to `lib/env.ts` schema:

Modify `lib/env.ts`:

```typescript
const envSchema = z.object({
  // ... existing fields ...
  RESCORE_DRAIN_MODE: z.enum(["true", "false"]).optional(),
});

export const envScope = {
  // ... existing scopes ...
  RESCORE_DRAIN_MODE: "pipeline",
} as const satisfies Record<keyof Env, "web" | "pipeline" | "both">;
```

`GEMINI_API_KEY` stays `.optional()` (validated at `lib/pipeline/gemini/client.ts` instantiation — see Task 7).

- [ ] **Step 3.3:** Update `.env.example`:

Add lines:

```
# Rescore drain mode: 'true' switches the rescore cron from monthly to daily cadence
# during a major prompt-version migration. Toggle back to 'false' (or unset) when the
# version-mismatched row count drops below ~100.
RESCORE_DRAIN_MODE=
```

- [ ] **Step 3.4:** Commit:

```bash
git add package.json pnpm-lock.yaml lib/env.ts .env.example
git commit -m "feat(env): add RESCORE_DRAIN_MODE + install @google/genai"
```

---

## Task 4 — Pure library modules (batch)

**Dependencies:** Task 3 (Gemini SDK)

This batch is pure TypeScript — no DB, no network. All files are deterministic and unit-testable.

**Files:**
- Create: `lib/pipeline/scoring/seed-feature-tags.ts`
- Create: `lib/pipeline/scoring/deterministic.ts`
- Create: `lib/pipeline/scoring/request-budget.ts`
- Create: `lib/pipeline/scoring/tag-normalizer.ts`
- Create: `lib/pipeline/gemini/errors.ts`
- Create: `lib/pipeline/metrics/scoring-metrics.ts`

### 4.1 seed-feature-tags.ts

- [ ] **Step 4.1.1:** Create `lib/pipeline/scoring/seed-feature-tags.ts`:

```typescript
// Canonical feature-tag enum. Source of truth for:
//   - Gemini responseSchema (feature_tags_canonical items.enum)
//   - Tag normalizer (what's "canonical" vs "freeform")
//   - DB migration 20260415000004_seed_feature_tags.sql (mirrored list)
//
// When adding/removing a slug, update the migration too. CI snippet
// validation catches divergence between this file and the DB state.

export const SEED_FEATURE_TAG_SLUGS = [
  "auth",
  "social_login",
  "magic_link",
  "payments",
  "stripe",
  "subscription",
  "dark_mode",
  "responsive",
  "animation",
  "ai_integration",
  "chatbot",
  "rag",
  "database_included",
  "realtime",
  "docker",
  "ci_cd",
  "self_hostable",
  "mdx",
  "cms",
  "blog_content",
  "email",
  "transactional_email",
  "analytics",
  "seo",
  "sitemap",
  "i18n",
  "rtl",
  "file_upload",
  "search",
  "notifications",
] as const;

export type SeedFeatureTagSlug = (typeof SEED_FEATURE_TAG_SLUGS)[number];

export function isSeedFeatureTag(slug: string): slug is SeedFeatureTagSlug {
  return (SEED_FEATURE_TAG_SLUGS as readonly string[]).includes(slug);
}
```

- [ ] **Step 4.1.2:** Create `tests/unit/pipeline/scoring/seed-feature-tags.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SEED_FEATURE_TAG_SLUGS, isSeedFeatureTag } from "@/lib/pipeline/scoring/seed-feature-tags";

describe("seed feature tags", () => {
  it("has 30 canonical slugs", () => {
    expect(SEED_FEATURE_TAG_SLUGS.length).toBe(30);
  });

  it("all slugs are lowercase snake_case", () => {
    for (const slug of SEED_FEATURE_TAG_SLUGS) {
      expect(slug).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("has no duplicates", () => {
    const set = new Set(SEED_FEATURE_TAG_SLUGS);
    expect(set.size).toBe(SEED_FEATURE_TAG_SLUGS.length);
  });

  it("isSeedFeatureTag type-narrows correctly", () => {
    expect(isSeedFeatureTag("auth")).toBe(true);
    expect(isSeedFeatureTag("not_a_tag")).toBe(false);
  });
});
```

### 4.2 request-budget.ts

- [ ] **Step 4.2.1:** Create `lib/pipeline/scoring/request-budget.ts`:

```typescript
// Domain-specific kill-switch for scoring. Tracks Gemini call count and
// cumulative USD cost against per-run limits. Job loop checks canProceed()
// before each call and halts cleanly on exhaustion.

export interface BudgetLimits {
  readonly maxCalls: number;
  readonly maxCostUsd: number;
}

export interface BudgetState {
  readonly calls: number;
  readonly costUsd: number;
  readonly exhausted: boolean;
}

// Flash-Lite pricing (2026-04, per 1M tokens)
const INPUT_COST_PER_TOKEN = 0.10e-6;
const OUTPUT_COST_PER_TOKEN = 0.40e-6;

export class RequestBudget {
  private _calls = 0;
  private _costUsd = 0;

  constructor(private readonly limits: BudgetLimits) {}

  recordCall(inputTokens: number, outputTokens: number): void {
    this._calls += 1;
    this._costUsd += inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
  }

  canProceed(): boolean {
    return this._calls < this.limits.maxCalls && this._costUsd < this.limits.maxCostUsd;
  }

  state(): BudgetState {
    return {
      calls: this._calls,
      costUsd: this._costUsd,
      exhausted: !this.canProceed(),
    };
  }
}
```

- [ ] **Step 4.2.2:** Create `tests/unit/pipeline/scoring/request-budget.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { RequestBudget } from "@/lib/pipeline/scoring/request-budget";

describe("RequestBudget", () => {
  it("allows calls within budget", () => {
    const b = new RequestBudget({ maxCalls: 10, maxCostUsd: 1 });
    expect(b.canProceed()).toBe(true);
    b.recordCall(1000, 200);
    expect(b.canProceed()).toBe(true);
  });

  it("stops at maxCalls", () => {
    const b = new RequestBudget({ maxCalls: 2, maxCostUsd: 100 });
    b.recordCall(1000, 200);
    b.recordCall(1000, 200);
    expect(b.canProceed()).toBe(false);
    expect(b.state().exhausted).toBe(true);
  });

  it("stops at maxCostUsd", () => {
    const b = new RequestBudget({ maxCalls: 1000, maxCostUsd: 0.0001 });
    b.recordCall(1000, 200);  // ~$0.0001 + $0.00008 = $0.00018
    expect(b.canProceed()).toBe(false);
  });

  it("state reports accurate call count and cost", () => {
    const b = new RequestBudget({ maxCalls: 10, maxCostUsd: 1 });
    b.recordCall(1000, 200);
    b.recordCall(2000, 400);
    const state = b.state();
    expect(state.calls).toBe(2);
    expect(state.costUsd).toBeCloseTo(
      1000 * 0.10e-6 + 200 * 0.40e-6 + 2000 * 0.10e-6 + 400 * 0.40e-6,
      9,
    );
  });
});
```

### 4.3 tag-normalizer.ts

- [ ] **Step 4.3.1:** Create `lib/pipeline/scoring/tag-normalizer.ts`:

```typescript
// Splits LLM-emitted feature tag arrays into:
//   - canonical: slugs present in the seed enum (linked to tags table)
//   - freeform: novel slugs (stored in repos.tags_freeform for monitoring)
//
// Also normalizes slugs: lowercase + non-alnum → '_'. Caps freeform at 20
// entries to match the DB CHECK constraint.

import { isSeedFeatureTag, SEED_FEATURE_TAG_SLUGS } from "./seed-feature-tags";

const MAX_FREEFORM_TAGS = 20;

export interface NormalizedTags {
  canonical: string[];
  freeform: string[];
}

export function normalizeSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function normalizeTags(
  canonicalInput: readonly string[],
  noveltyInput: readonly string[],
): NormalizedTags {
  const seen = new Set<string>();
  const canonical: string[] = [];
  const freeform: string[] = [];

  // LLM may emit canonical slugs in the novelty array or vice versa.
  // Merge both and re-classify.
  for (const raw of [...canonicalInput, ...noveltyInput]) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const slug = normalizeSlug(raw);
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    if (isSeedFeatureTag(slug)) {
      canonical.push(slug);
    } else {
      if (freeform.length < MAX_FREEFORM_TAGS) {
        freeform.push(slug);
      }
    }
  }

  return { canonical, freeform };
}
```

- [ ] **Step 4.3.2:** Create `tests/unit/pipeline/scoring/tag-normalizer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeTags, normalizeSlug } from "@/lib/pipeline/scoring/tag-normalizer";

describe("normalizeSlug", () => {
  it("lowercases", () => {
    expect(normalizeSlug("Auth")).toBe("auth");
  });
  it("replaces non-alnum with _", () => {
    expect(normalizeSlug("dark-mode")).toBe("dark_mode");
    expect(normalizeSlug("AI/ML")).toBe("ai_ml");
  });
  it("trims leading/trailing underscores", () => {
    expect(normalizeSlug("-foo-")).toBe("foo");
  });
});

describe("normalizeTags", () => {
  it("splits canonical vs freeform", () => {
    const r = normalizeTags(["auth", "my_custom"], ["dark_mode", "weird-thing"]);
    expect(r.canonical.sort()).toEqual(["auth", "dark_mode"]);
    expect(r.freeform.sort()).toEqual(["my_custom", "weird_thing"]);
  });

  it("dedupes across inputs", () => {
    const r = normalizeTags(["auth", "auth"], ["auth"]);
    expect(r.canonical).toEqual(["auth"]);
    expect(r.freeform).toEqual([]);
  });

  it("normalizes variants to canonical (dark-mode → dark_mode)", () => {
    const r = normalizeTags([], ["dark-mode", "Dark Mode"]);
    expect(r.canonical).toEqual(["dark_mode"]);
  });

  it("caps freeform at 20", () => {
    const novelty = Array.from({ length: 30 }, (_, i) => `novel_${i}`);
    const r = normalizeTags([], novelty);
    expect(r.freeform.length).toBe(20);
  });

  it("handles empty + non-string inputs", () => {
    // @ts-expect-error intentional bad input
    const r = normalizeTags(["", null, undefined, "auth"], []);
    expect(r.canonical).toEqual(["auth"]);
  });
});
```

### 4.4 deterministic.ts

- [ ] **Step 4.4.1:** Create `lib/pipeline/scoring/deterministic.ts`:

```typescript
// Computes the 4 deterministic scoring axes from repo metadata + capabilities.
// Pure functions — no DB, no side effects. Results fed into apply_score_result RPC
// alongside Gemini-produced documentation + code_health_readme scores.

export interface DeterministicInput {
  stars: number;
  forks: number;
  watchers: number;
  githubCreatedAt: Date;
  lastCommitAt: Date;
  capabilities: {
    has_package_json?: boolean;
    has_readme?: boolean;
    vibecoding_tools?: readonly string[];
  };
  fileTree: readonly { path: string; type: "file" | "dir" }[];
  packageJsonContent: string | null;
  repoAssetCount: { gif: number; image: number };
  assetsExtractedAt: Date | null;
}

export interface DeterministicScores {
  popularity_score: number;      // 0-5
  maintenance_score: number;     // 0-5
  code_health_score_deterministic: number;  // 0-5, merged with LLM portion later
  visual_preview_score: number;  // 0-5
}

export function computeDeterministicScores(input: DeterministicInput): DeterministicScores {
  return {
    popularity_score: computePopularity(input),
    maintenance_score: computeMaintenance(input),
    code_health_score_deterministic: computeCodeHealth(input),
    visual_preview_score: computeVisualPreview(input),
  };
}

// ──────────────────────────────────────────────────────────────────────
// popularity: log(stars+1) / log(months+2), capped at 5
// ──────────────────────────────────────────────────────────────────────
function computePopularity(input: DeterministicInput): number {
  const ageMs = Date.now() - input.githubCreatedAt.getTime();
  const months = Math.max(0, ageMs / (1000 * 60 * 60 * 24 * 30));
  // log(stars+1) / log(months+2) × 5, then cap at 5
  // months+2 ensures denominator > 1 even for brand-new repos
  const raw = (Math.log(input.stars + 1) / Math.log(months + 2)) * 2.5;
  return clamp(raw, 0, 5);
}

// ──────────────────────────────────────────────────────────────────────
// maintenance: last_commit freshness (6mo=5, 12mo=3, 24mo=1)
// ──────────────────────────────────────────────────────────────────────
function computeMaintenance(input: DeterministicInput): number {
  const ageMs = Date.now() - input.lastCommitAt.getTime();
  const days = ageMs / (1000 * 60 * 60 * 24);
  if (days <= 180) return 5;
  if (days <= 365) return 3;
  if (days <= 730) return 1;
  return 0;
}

// ──────────────────────────────────────────────────────────────────────
// code_health (deterministic portion): tests presence + dep count
// ──────────────────────────────────────────────────────────────────────
function computeCodeHealth(input: DeterministicInput): number {
  let score = 2;  // baseline

  const hasTests = input.fileTree.some((e) =>
    /(^|\/)(tests?|__tests__)\//.test(e.path) ||
    /\.(test|spec)\.[jt]sx?$/.test(e.path) ||
    /^(vitest|jest|playwright)\.config\./.test(e.path),
  );
  if (hasTests) score += 2;

  if (input.capabilities.has_package_json) {
    try {
      const pkg = JSON.parse(input.packageJsonContent ?? "{}");
      const deps = Object.keys(pkg.dependencies ?? {}).length;
      const devDeps = Object.keys(pkg.devDependencies ?? {}).length;
      const total = deps + devDeps;
      // Reasonable range: 10-50. Too few (bare scaffold) or too many (bloat) both reduce.
      if (total >= 10 && total <= 50) score += 1;
    } catch {
      // malformed package.json: no bonus
    }
  }

  return clamp(score, 0, 5);
}

// ──────────────────────────────────────────────────────────────────────
// visual_preview: asset count + GIF/image mix
// ──────────────────────────────────────────────────────────────────────
function computeVisualPreview(input: DeterministicInput): number {
  if (input.assetsExtractedAt === null) {
    // Extraction wasn't attempted yet; return neutral 2.5 so we don't
    // wrongly gate this repo. The publish gate also checks
    // assets_extracted_at IS NULL and skips the visual_preview check.
    return 2.5;
  }
  const gif = input.repoAssetCount.gif;
  const image = input.repoAssetCount.image;
  if (gif > 0) return 5;
  if (image >= 3) return 4;
  if (image >= 1) return 3;
  return 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
```

- [ ] **Step 4.4.2:** Create `tests/unit/pipeline/scoring/deterministic.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeDeterministicScores } from "@/lib/pipeline/scoring/deterministic";

const NOW = new Date("2026-04-14T00:00:00Z");

function baseInput(overrides = {}) {
  return {
    stars: 100,
    forks: 10,
    watchers: 5,
    githubCreatedAt: new Date("2024-04-14T00:00:00Z"),  // 2 years old
    lastCommitAt: new Date("2026-02-14T00:00:00Z"),     // 2 months ago
    capabilities: { has_package_json: true, has_readme: true },
    fileTree: [
      { path: "package.json", type: "file" as const },
      { path: "tests/foo.test.ts", type: "file" as const },
    ],
    packageJsonContent: JSON.stringify({
      dependencies: { react: "19", next: "16", tailwindcss: "4", zod: "4" },
      devDependencies: { typescript: "5", vitest: "4", eslint: "9" },
    }),
    repoAssetCount: { gif: 1, image: 2 },
    assetsExtractedAt: new Date("2026-04-13T00:00:00Z"),
    ...overrides,
  };
}

describe("computeDeterministicScores — popularity", () => {
  it("scores 0 for brand-new repo with 0 stars", () => {
    const r = computeDeterministicScores(baseInput({
      stars: 0,
      githubCreatedAt: new Date("2026-04-13T00:00:00Z"),
    }));
    expect(r.popularity_score).toBe(0);
  });

  it("scores > 0 for old repo with many stars", () => {
    const r = computeDeterministicScores(baseInput({
      stars: 10000,
      githubCreatedAt: new Date("2020-01-01T00:00:00Z"),
    }));
    expect(r.popularity_score).toBeGreaterThan(2);
    expect(r.popularity_score).toBeLessThanOrEqual(5);
  });

  it("caps at 5 even for massive star counts", () => {
    const r = computeDeterministicScores(baseInput({ stars: 10_000_000 }));
    expect(r.popularity_score).toBeLessThanOrEqual(5);
  });

  it("handles months=0 (created today)", () => {
    const r = computeDeterministicScores(baseInput({
      stars: 100,
      githubCreatedAt: new Date(),
    }));
    expect(Number.isFinite(r.popularity_score)).toBe(true);
  });
});

describe("computeDeterministicScores — maintenance", () => {
  it("5 for recent commit (within 6 months)", () => {
    const r = computeDeterministicScores(baseInput({
      lastCommitAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),  // 30 days
    }));
    expect(r.maintenance_score).toBe(5);
  });

  it("3 for 9 months old", () => {
    const r = computeDeterministicScores(baseInput({
      lastCommitAt: new Date(Date.now() - 270 * 24 * 60 * 60 * 1000),
    }));
    expect(r.maintenance_score).toBe(3);
  });

  it("1 for 2 years old", () => {
    const r = computeDeterministicScores(baseInput({
      lastCommitAt: new Date(Date.now() - 600 * 24 * 60 * 60 * 1000),
    }));
    expect(r.maintenance_score).toBe(1);
  });

  it("0 for 3+ years old", () => {
    const r = computeDeterministicScores(baseInput({
      lastCommitAt: new Date(Date.now() - 1200 * 24 * 60 * 60 * 1000),
    }));
    expect(r.maintenance_score).toBe(0);
  });
});

describe("computeDeterministicScores — code_health (deterministic)", () => {
  it("rewards tests presence", () => {
    const r1 = computeDeterministicScores(baseInput({ fileTree: [{ path: "package.json", type: "file" }] }));
    const r2 = computeDeterministicScores(baseInput());  // has tests/
    expect(r2.code_health_score_deterministic).toBeGreaterThan(r1.code_health_score_deterministic);
  });

  it("rewards reasonable dep count", () => {
    const r = computeDeterministicScores(baseInput());
    expect(r.code_health_score_deterministic).toBeGreaterThanOrEqual(4);
  });

  it("handles malformed package.json without throwing", () => {
    const r = computeDeterministicScores(baseInput({ packageJsonContent: "not json" }));
    expect(Number.isFinite(r.code_health_score_deterministic)).toBe(true);
  });
});

describe("computeDeterministicScores — visual_preview", () => {
  it("5 when any GIF present", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 1, image: 0 } }));
    expect(r.visual_preview_score).toBe(5);
  });

  it("4 with 3+ images, no GIF", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 0, image: 3 } }));
    expect(r.visual_preview_score).toBe(4);
  });

  it("3 with 1-2 images", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 0, image: 1 } }));
    expect(r.visual_preview_score).toBe(3);
  });

  it("0 with no assets AND extraction attempted", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 0, image: 0 } }));
    expect(r.visual_preview_score).toBe(0);
  });

  it("2.5 (neutral) when assetsExtractedAt is null (extraction not attempted)", () => {
    const r = computeDeterministicScores(baseInput({
      assetsExtractedAt: null,
      repoAssetCount: { gif: 0, image: 0 },
    }));
    expect(r.visual_preview_score).toBe(2.5);
  });
});
```

### 4.5 gemini/errors.ts

- [ ] **Step 4.5.1:** Create `lib/pipeline/gemini/errors.ts`:

```typescript
// Typed error hierarchy for Gemini API calls. Mirrors the pattern in
// lib/pipeline/github/errors.ts so score-repo can narrow via instanceof.

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** HTTP 429 — quota exhausted. Job should halt; next cron retries. */
export class GeminiRateLimitError extends GeminiError {}

/** HTTP 5xx — transient. Caller may retry inline with backoff. */
export class GeminiServerError extends GeminiError {
  constructor(readonly status: number, message: string) {
    super(`Gemini ${status}: ${message}`);
  }
}

/** Safety/content filter tripped. Repo → needs_review. */
export class GeminiContentFilterError extends GeminiError {}

/** Response JSON did not match responseSchema. Retry once with error re-injection. */
export class SchemaValidationError extends GeminiError {
  constructor(message: string, readonly raw: unknown) {
    super(message);
  }
}

/** Response truncated (MAX_TOKENS finish reason). Retry with more output budget. */
export class TruncatedResponseError extends GeminiError {}
```

- [ ] **Step 4.5.2:** Create `tests/unit/pipeline/gemini/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  GeminiError,
  GeminiRateLimitError,
  GeminiServerError,
  GeminiContentFilterError,
  SchemaValidationError,
  TruncatedResponseError,
} from "@/lib/pipeline/gemini/errors";

describe("Gemini error hierarchy", () => {
  it("GeminiRateLimitError is instanceof GeminiError", () => {
    const e = new GeminiRateLimitError("rate limited");
    expect(e).toBeInstanceOf(GeminiError);
    expect(e.name).toBe("GeminiRateLimitError");
  });

  it("GeminiServerError carries status", () => {
    const e = new GeminiServerError(503, "unavailable");
    expect(e.status).toBe(503);
    expect(e.message).toContain("503");
  });

  it("SchemaValidationError preserves raw response", () => {
    const e = new SchemaValidationError("missing field", { partial: true });
    expect(e.raw).toEqual({ partial: true });
  });

  it("all classes set name to constructor name (for log filters)", () => {
    expect(new GeminiContentFilterError("x").name).toBe("GeminiContentFilterError");
    expect(new TruncatedResponseError("x").name).toBe("TruncatedResponseError");
  });
});
```

### 4.6 metrics/scoring-metrics.ts

- [ ] **Step 4.6.1:** Create `lib/pipeline/metrics/scoring-metrics.ts`:

```typescript
// Structured shape for scoring-job metrics. Using an interface with
// recordScoreMetrics forces typo-safety: ctx.metric('repos_socred', n)
// is impossible when callers must go through this helper.

import type { JobContext } from "@/lib/types/jobs";

export interface ScoreJobMetrics {
  repos_claimed: number;
  repos_scored: number;
  repos_published: number;
  repos_gated: number;
  repos_needs_review: number;
  repos_skipped_schema: number;
  repos_skipped_server_error: number;
  repos_skipped_readme_fetch: number;
  repos_stuck_reset: number;
  gemini_calls: number;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  gemini_429_count: number;
  cost_usd: number;
  budget_exhausted: boolean;
  avg_latency_ms: number;
}

export function recordScoreMetrics(ctx: JobContext, metrics: ScoreJobMetrics): void {
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" || typeof value === "boolean") {
      ctx.metric(key, typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
  }
}
```

No dedicated unit test — interface-only; usage tested in score-job integration tests.

- [ ] **Step 4.7:** Verify all new tests pass:

```bash
pnpm test:unit
```

Expected: all green. New tests from this batch: ~30 assertions across seed/budget/tag/deterministic/errors.

- [ ] **Step 4.8:** Commit:

```bash
git add lib/pipeline/scoring/ lib/pipeline/gemini/errors.ts lib/pipeline/metrics/ tests/unit/pipeline/
git commit -m "feat(pipeline): pure scoring modules (seed tags, budget, normalizer, deterministic, errors, metrics)"
```

---

## Task 5 — Gemini prompt builder + README section extractor

**Dependencies:** Task 4

**Files:**
- Modify: `lib/pipeline/extractors/readme-media.ts` (export `parseReadme`)
- Create: `lib/pipeline/extractors/readme-sections.ts`
- Create: `lib/pipeline/gemini/scoring-prompt.ts`

- [ ] **Step 5.1:** Refactor `lib/pipeline/extractors/readme-media.ts` to export `parseReadme`:

In `lib/pipeline/extractors/readme-media.ts`, add top-level export:

```typescript
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Parse markdown into an mdast Root. Shared between readme-media (image walker)
 * and readme-sections (heading-based slicing) to avoid parsing the same blob twice.
 */
export function parseReadme(markdown: string): Root {
  return unified().use(remarkParse).parse(markdown) as Root;
}
```

Update the existing `extractReadmeMedia` function body to call `parseReadme(readmeMarkdown)` instead of the inline `unified().use(remarkParse).parse(...)` call.

- [ ] **Step 5.2:** Create `lib/pipeline/extractors/readme-sections.ts`:

```typescript
// Extract README sections by heading. Gemini gets section-extracted content
// (Features, Getting Started, Usage, Tech Stack) for much higher signal density
// than head-truncation. Falls back to first 8000 chars if no headings found.

import type { Heading, Root, RootContent } from "mdast";
import { parseReadme } from "./readme-media";

const TARGET_HEADINGS = [
  "features",
  "getting started",
  "quick start",
  "installation",
  "install",
  "setup",
  "usage",
  "tech stack",
  "stack",
  "what's inside",
];

const FALLBACK_LIMIT = 8000;

export interface ExtractedSections {
  /** Concatenated target sections, or first 8k chars fallback. */
  content: string;
  /** True if heading-based extraction succeeded. */
  structured: boolean;
}

export function extractReadmeSections(markdown: string): ExtractedSections {
  if (!markdown) return { content: "", structured: false };

  let tree: Root;
  try {
    tree = parseReadme(markdown);
  } catch {
    return fallback(markdown);
  }

  const sections: string[] = [];
  const children = tree.children;

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!isHeading(node)) continue;
    const title = headingText(node).trim().toLowerCase();
    if (!TARGET_HEADINGS.some((t) => title.includes(t))) continue;

    // Collect nodes until the next heading at the same or higher level
    const start = i;
    let end = i + 1;
    const startLevel = node.depth;
    while (end < children.length) {
      const next = children[end];
      if (isHeading(next) && next.depth <= startLevel) break;
      end += 1;
    }
    sections.push(nodesToString(children.slice(start, end), markdown));
  }

  if (sections.length === 0) return fallback(markdown);
  return { content: sections.join("\n\n").slice(0, FALLBACK_LIMIT), structured: true };
}

function fallback(markdown: string): ExtractedSections {
  return { content: markdown.slice(0, FALLBACK_LIMIT), structured: false };
}

function isHeading(node: RootContent): node is Heading {
  return node.type === "heading";
}

function headingText(node: Heading): string {
  return node.children
    .map((c) => ("value" in c ? c.value : ""))
    .join("");
}

function nodesToString(nodes: RootContent[], original: string): string {
  if (nodes.length === 0) return "";
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first?.position || !last?.position) return "";
  return original.slice(first.position.start.offset ?? 0, last.position.end.offset ?? original.length);
}
```

- [ ] **Step 5.3:** Create `tests/unit/pipeline/extractors/readme-sections.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractReadmeSections } from "@/lib/pipeline/extractors/readme-sections";

describe("extractReadmeSections", () => {
  it("returns empty structured=false for empty input", () => {
    const r = extractReadmeSections("");
    expect(r.content).toBe("");
    expect(r.structured).toBe(false);
  });

  it("extracts Features + Getting Started sections", () => {
    const md = `
# Repo Name

Tagline here.

## Features

- Feature 1
- Feature 2

## Getting Started

Run npm install.

## License

MIT.
`.trim();
    const r = extractReadmeSections(md);
    expect(r.structured).toBe(true);
    expect(r.content).toContain("Features");
    expect(r.content).toContain("Getting Started");
    expect(r.content).not.toContain("MIT");  // License section dropped
  });

  it("falls back to first 8000 chars when no target headings", () => {
    const md = "## Random Heading\n\nNo target sections here.";
    const r = extractReadmeSections(md);
    expect(r.structured).toBe(false);
    expect(r.content.startsWith("## Random Heading")).toBe(true);
  });

  it("caps output at FALLBACK_LIMIT", () => {
    const md = "## Usage\n\n" + "x".repeat(20000);
    const r = extractReadmeSections(md);
    expect(r.content.length).toBeLessThanOrEqual(8000);
  });
});
```

- [ ] **Step 5.4:** Create `lib/pipeline/gemini/scoring-prompt.ts`:

```typescript
// Builds the single-prompt scoring request for Gemini Flash-Lite.
// See docs/superpowers/specs/2026-04-14-evaluation-classification-design.md §2.

import { SEED_FEATURE_TAG_SLUGS } from "@/lib/pipeline/scoring/seed-feature-tags";

export const SCORING_PROMPT_VERSION = "1.0.0";
export const SCORING_MODEL = "gemini-flash-lite-latest";

const CATEGORIES = [
  "saas", "ecommerce", "dashboard", "landing_page", "ai_tool",
  "utility", "game", "portfolio", "blog", "chatbot", "mobile_app", "other",
] as const;

export interface ScoringPromptInput {
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  lastCommitIso: string;
  license: string | null;
  techStackSlugs: readonly string[];
  vibecodingToolSlugs: readonly string[];
  hasReadme: boolean;
  hasPackageJson: boolean;
  /** Structure-extracted README sections, or first-8k fallback. Empty if has_readme=false. */
  readmeSections: string;
}

export interface ScoringPromptOutput {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: object;
  version: string;
}

export function buildScoringPrompt(input: ScoringPromptInput): ScoringPromptOutput {
  const systemPrompt =
    "당신은 오픈소스 GitHub 리포의 품질을 평가하는 큐레이터입니다. " +
    "바이브코더(비개발자 + Cursor/Lovable/Bolt 유저)가 이 템플릿을 자기 프로젝트에 " +
    "써도 될지 판단하는 것이 목적입니다.";

  const userPrompt = buildUserPrompt(input);
  const responseSchema = buildResponseSchema();

  return { systemPrompt, userPrompt, responseSchema, version: SCORING_PROMPT_VERSION };
}

function buildUserPrompt(input: ScoringPromptInput): string {
  const lines: string[] = [];
  lines.push(`리포: ${input.owner}/${input.name}`);
  if (input.description) lines.push(`설명: ${input.description}`);
  lines.push(`스타: ${input.stars}`);
  lines.push(`마지막 커밋: ${input.lastCommitIso}`);
  if (input.license) lines.push(`라이선스: ${input.license}`);
  if (input.techStackSlugs.length > 0) {
    lines.push(`감지된 기술스택: ${input.techStackSlugs.join(", ")} (heuristic; README 기준으로 교정 가능)`);
  }
  if (input.vibecodingToolSlugs.length > 0) {
    lines.push(`바이브코딩 도구 마커: ${input.vibecodingToolSlugs.join(", ")}`);
  }
  lines.push(`README 존재: ${input.hasReadme ? "yes" : "no"}`);
  lines.push(`package.json 존재: ${input.hasPackageJson ? "yes" : "no"}`);

  if (input.readmeSections) {
    lines.push("");
    lines.push("README 섹션 발췌:");
    lines.push(input.readmeSections);
  } else {
    lines.push("");
    lines.push("(README 본문 없음 — 메타데이터 기준으로만 평가)");
  }

  lines.push("");
  lines.push("다음 기준으로 평가하고 JSON으로 응답:");
  lines.push("- documentation: 1-5, README 구조/설치 가이드/스크린샷 언급 품질");
  lines.push("- code_health_readme: 1-5, README에서 추론 가능한 품질 시그널 (주석/예제/구조 설명)");
  lines.push("- category: 아래 enum에서 1개");
  lines.push("- feature_tags_canonical: 아래 30개 슬러그 중 해당 항목만");
  lines.push("- feature_tags_novel: 리포가 제공하는 기능 중 위 30개에 없는 신규 슬러그 (소문자 snake_case)");
  lines.push("- evidence_strength: 'strong' (Features + Getting Started 섹션 모두 존재), 'partial' (둘 중 하나), 'weak' (둘 다 없음)");

  return lines.join("\n");
}

function buildResponseSchema(): object {
  // IMPORTANT: per-axis field order puts `value` BEFORE `rationale` so the
  // numeric score isn't conditioned on post-hoc prose (Flash-Lite is
  // sensitive to field-generation order).
  return {
    type: "object",
    properties: {
      documentation: {
        type: "object",
        properties: {
          value: { type: "integer", minimum: 1, maximum: 5 },
          rationale: { type: "string" },
        },
        required: ["value", "rationale"],
      },
      code_health_readme: {
        type: "object",
        properties: {
          value: { type: "integer", minimum: 1, maximum: 5 },
          rationale: { type: "string" },
        },
        required: ["value", "rationale"],
      },
      category: { type: "string", enum: [...CATEGORIES] },
      feature_tags_canonical: {
        type: "array",
        items: { type: "string", enum: [...SEED_FEATURE_TAG_SLUGS] },
      },
      feature_tags_novel: {
        type: "array",
        items: { type: "string" },
      },
      evidence_strength: { type: "string", enum: ["strong", "partial", "weak"] },
    },
    required: [
      "documentation",
      "code_health_readme",
      "category",
      "feature_tags_canonical",
      "feature_tags_novel",
      "evidence_strength",
    ],
  };
}
```

- [ ] **Step 5.5:** Create `tests/unit/pipeline/gemini/scoring-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildScoringPrompt, SCORING_PROMPT_VERSION } from "@/lib/pipeline/gemini/scoring-prompt";
import { SEED_FEATURE_TAG_SLUGS } from "@/lib/pipeline/scoring/seed-feature-tags";

const FIXTURE = {
  owner: "vercel",
  name: "next.js",
  description: "The React Framework",
  stars: 100000,
  lastCommitIso: "2026-04-10T00:00:00Z",
  license: "mit",
  techStackSlugs: ["nextjs", "react", "typescript"],
  vibecodingToolSlugs: ["cursor"],
  hasReadme: true,
  hasPackageJson: true,
  readmeSections: "## Features\n\n- Fast\n\n## Getting Started\n\nnpm install",
};

describe("buildScoringPrompt", () => {
  it("returns version matching exported constant", () => {
    const r = buildScoringPrompt(FIXTURE);
    expect(r.version).toBe(SCORING_PROMPT_VERSION);
  });

  it("system prompt mentions vibe coders", () => {
    const r = buildScoringPrompt(FIXTURE);
    expect(r.systemPrompt).toContain("바이브코더");
  });

  it("user prompt includes all metadata fields", () => {
    const r = buildScoringPrompt(FIXTURE);
    expect(r.userPrompt).toContain("vercel/next.js");
    expect(r.userPrompt).toContain("The React Framework");
    expect(r.userPrompt).toContain("100000");
    expect(r.userPrompt).toContain("cursor");
    expect(r.userPrompt).toContain("Features");
    expect(r.userPrompt).toContain("Getting Started");
  });

  it("responseSchema has value before rationale in each axis", () => {
    const r = buildScoringPrompt(FIXTURE);
    const schema = r.responseSchema as any;
    const docRequired = schema.properties.documentation.required;
    expect(docRequired.indexOf("value")).toBeLessThan(docRequired.indexOf("rationale"));
  });

  it("responseSchema includes all 12 categories", () => {
    const r = buildScoringPrompt(FIXTURE);
    const categories = (r.responseSchema as any).properties.category.enum;
    expect(categories).toHaveLength(12);
    expect(categories).toContain("portfolio");
    expect(categories).toContain("chatbot");
  });

  it("feature_tags_canonical enum matches SEED_FEATURE_TAG_SLUGS", () => {
    const r = buildScoringPrompt(FIXTURE);
    const enumSlugs = (r.responseSchema as any).properties.feature_tags_canonical.items.enum;
    expect(enumSlugs.sort()).toEqual([...SEED_FEATURE_TAG_SLUGS].sort());
  });

  it("handles hasReadme=false path (no README section)", () => {
    const r = buildScoringPrompt({ ...FIXTURE, hasReadme: false, readmeSections: "" });
    expect(r.userPrompt).toContain("README 본문 없음");
  });
});
```

- [ ] **Step 5.6:** Run tests:

```bash
pnpm test:unit
```

Expected: all new tests pass (7 from scoring-prompt, 4 from readme-sections).

- [ ] **Step 5.7:** Commit:

```bash
git add lib/pipeline/extractors/readme-media.ts lib/pipeline/extractors/readme-sections.ts lib/pipeline/gemini/scoring-prompt.ts tests/unit/pipeline/
git commit -m "feat(pipeline): README section extractor + Gemini scoring prompt builder"
```

---

## Task 6 — Gemini client + tag resolution helper

**Dependencies:** Task 5

**Files:**
- Create: `lib/pipeline/gemini/client.ts`
- Create: `lib/pipeline/tags/resolve.ts`
- Modify: `lib/pipeline/jobs/discover.ts` (migrate to tags/resolve.ts)

### 6.1 Gemini client

- [ ] **Step 6.1.1:** Create `lib/pipeline/gemini/client.ts`:

```typescript
// Thin wrapper around @google/genai. Validates GEMINI_API_KEY at instantiation
// (keeping env.ts's GEMINI_API_KEY as optional so web-scope cold boot doesn't
// fail — validation is deferred to the point of use).

import { GoogleGenAI } from "@google/genai";
import { env } from "@/lib/env";
import {
  GeminiContentFilterError,
  GeminiRateLimitError,
  GeminiServerError,
  SchemaValidationError,
  TruncatedResponseError,
} from "./errors";
import type { RequestBudget } from "@/lib/pipeline/scoring/request-budget";

export interface GeminiScoreRequest {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: object;
  model: string;
}

export interface GeminiScoreResponse {
  data: unknown;          // parsed JSON matching responseSchema
  inputTokens: number;
  outputTokens: number;
}

export class GeminiClient {
  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY required for scoring pipeline");
    }
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async score(req: GeminiScoreRequest, budget: RequestBudget): Promise<GeminiScoreResponse> {
    const MAX_RETRIES = 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (!budget.canProceed()) {
        throw lastError ?? new Error("budget exhausted before call");
      }

      try {
        const response = await this.client.models.generateContent({
          model: req.model,
          contents: [
            { role: "user", parts: [{ text: req.userPrompt }] },
          ],
          config: {
            systemInstruction: req.systemPrompt,
            responseMimeType: "application/json",
            responseSchema: req.responseSchema as never,
          },
        });

        // Token accounting
        const input = response.usageMetadata?.promptTokenCount ?? 0;
        const output = response.usageMetadata?.candidatesTokenCount ?? 0;
        budget.recordCall(input, output);

        // Finish reason check (truncated responses)
        const finishReason = response.candidates?.[0]?.finishReason;
        if (finishReason === "MAX_TOKENS") {
          throw new TruncatedResponseError("Gemini response truncated (MAX_TOKENS)");
        }
        if (finishReason === "SAFETY" || finishReason === "BLOCKED") {
          throw new GeminiContentFilterError(`Gemini content filter: ${finishReason}`);
        }

        const text = response.text ?? "";
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          throw new SchemaValidationError(`JSON parse failed: ${String(parseErr)}`, text);
        }

        return { data: parsed, inputTokens: input, outputTokens: output };
      } catch (err) {
        lastError = err;
        if (err instanceof GeminiContentFilterError) throw err;  // no retry
        if (err instanceof TruncatedResponseError) throw err;    // no retry (same prompt)
        if (isRateLimit(err)) {
          throw new GeminiRateLimitError(String(err));
        }
        if (isServerError(err)) {
          if (attempt < MAX_RETRIES) {
            await sleep(Math.pow(4, attempt) * 500);
            continue;
          }
          throw new GeminiServerError(extractStatus(err) ?? 500, String(err));
        }
        if (err instanceof SchemaValidationError) {
          if (attempt < MAX_RETRIES) {
            // Re-inject error into prompt to coax valid JSON
            req = {
              ...req,
              userPrompt: `${req.userPrompt}\n\n주의: 이전 응답이 스키마 검증에 실패했습니다 (${err.message}). 제공된 JSON 스키마에 정확히 일치하는 JSON만 반환하세요.`,
            };
            continue;
          }
          throw err;
        }
        // Unknown error — bubble up
        throw err;
      }
    }

    throw lastError ?? new Error("unreachable");
  }
}

function isRateLimit(err: unknown): boolean {
  const status = extractStatus(err);
  return status === 429;
}

function isServerError(err: unknown): boolean {
  const status = extractStatus(err);
  return typeof status === "number" && status >= 500 && status < 600;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

Note: the Gemini SDK API signature may evolve. Verify against the SDK version installed in Task 3. If `generateContent` signature differs, adjust — this code block shows the 2026-Q1 stable shape.

### 6.2 Tag resolution helper

- [ ] **Step 6.2.1:** Create `lib/pipeline/tags/resolve.ts`:

```typescript
// Extracted from lib/pipeline/jobs/discover.ts — shared tag resolution logic.
// Caller provides slugs + kind + source; helper handles:
//   1. batch-select existing tags by slug
//   2. batch-insert missing with proper kind
//   3. upsert repo_tags junction rows
//
// Used by both discoverJob (tech_stack + vibecoding_tool tags) and
// scoreRepo (feature tags).

import type { SupabaseClient } from "@/lib/db";

export interface TagInput {
  slug: string;
  kind: "tech_stack" | "vibecoding_tool" | "feature";
  label?: string;
  confidence: number;
  source: "auto" | "auto_llm" | "manual";
}

export async function upsertAndLinkTags(
  db: SupabaseClient,
  repoId: string,
  tags: readonly TagInput[],
): Promise<{ linked: number }> {
  if (tags.length === 0) return { linked: 0 };

  // Dedupe by (slug, kind)
  const seen = new Set<string>();
  const unique: TagInput[] = [];
  for (const t of tags) {
    const key = `${t.kind}:${t.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  // Batch-select existing tag rows
  const slugs = unique.map((t) => t.slug);
  const { data: existing, error: selErr } = await db
    .from("tags")
    .select("id, slug, kind")
    .in("slug", slugs);
  if (selErr) throw new Error(`tags select failed: ${selErr.message}`);

  const byKey = new Map<string, { id: string; slug: string; kind: string }>();
  for (const row of existing ?? []) {
    byKey.set(`${row.kind}:${row.slug.toLowerCase()}`, row);
  }

  // Insert missing
  const missing = unique.filter((t) => !byKey.has(`${t.kind}:${t.slug.toLowerCase()}`));
  if (missing.length > 0) {
    const rows = missing.map((t) => ({
      slug: t.slug,
      kind: t.kind,
      label: t.label ?? humanize(t.slug),
    }));
    const { data: inserted, error: insErr } = await db
      .from("tags")
      .upsert(rows, { onConflict: "slug", ignoreDuplicates: false })
      .select("id, slug, kind");
    if (insErr) throw new Error(`tags insert failed: ${insErr.message}`);
    for (const row of inserted ?? []) {
      byKey.set(`${row.kind}:${row.slug.toLowerCase()}`, row);
    }
  }

  // Upsert junction rows
  const junctionRows = unique
    .map((t) => {
      const tag = byKey.get(`${t.kind}:${t.slug.toLowerCase()}`);
      if (!tag) return null;
      return {
        repo_id: repoId,
        tag_id: tag.id,
        confidence: t.confidence,
        source: t.source,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (junctionRows.length === 0) return { linked: 0 };

  const { error: juncErr } = await db
    .from("repo_tags")
    .upsert(junctionRows, { onConflict: "repo_id,tag_id", ignoreDuplicates: true });
  if (juncErr) throw new Error(`repo_tags upsert failed: ${juncErr.message}`);

  return { linked: junctionRows.length };
}

function humanize(slug: string): string {
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
```

- [ ] **Step 6.2.2:** Refactor `lib/pipeline/jobs/discover.ts` to use `upsertAndLinkTags`:

In `lib/pipeline/jobs/discover.ts`, replace the inline `insertRepoTags` function (currently ~70 lines) with a call to the shared helper:

```typescript
import { upsertAndLinkTags, type TagInput } from "@/lib/pipeline/tags/resolve";

// Inside ingestOne or equivalent caller:
const tagInputs: TagInput[] = [
  ...techTags.map((t) => ({ ...t, source: "auto" as const })),
  ...vibecodingTags.map((t) => ({ ...t, source: "auto" as const })),
];
await upsertAndLinkTags(ctx.db, repoId, tagInputs);
```

Delete the old `insertRepoTags` function body.

- [ ] **Step 6.3:** Run existing tests to verify refactor didn't break discover:

```bash
pnpm test:unit
pnpm test:integration  # if Docker available
```

Expected: discover-job.test.ts still passes.

- [ ] **Step 6.4:** Commit:

```bash
git add lib/pipeline/gemini/client.ts lib/pipeline/tags/resolve.ts lib/pipeline/jobs/discover.ts
git commit -m "feat(pipeline): Gemini client + shared tag resolution helper"
```

---

## Task 7 — Per-repo scoring orchestrator

**Dependencies:** Tasks 4, 5, 6, plus existing `lib/pipeline/github/client.ts` (for README fetch).

**Files:**
- Create: `lib/pipeline/scoring/score-repo.ts`

- [ ] **Step 7.1:** Create `lib/pipeline/scoring/score-repo.ts`:

```typescript
// Score a single repo: fetch README → deterministic + Gemini scores →
// apply_score_result RPC. Called from both score.ts (first-time) and
// rescore.ts (monthly) with is_rescore flag.

import { githubFetch } from "@/lib/pipeline/github/client";
import { NotFoundError, PermissionError } from "@/lib/pipeline/github/errors";
import type { SupabaseClient } from "@/lib/db";
import type { JobContext } from "@/lib/types/jobs";
import { GeminiClient } from "@/lib/pipeline/gemini/client";
import {
  GeminiContentFilterError,
  SchemaValidationError,
} from "@/lib/pipeline/gemini/errors";
import { buildScoringPrompt, SCORING_MODEL } from "@/lib/pipeline/gemini/scoring-prompt";
import { extractReadmeSections } from "@/lib/pipeline/extractors/readme-sections";
import { computeDeterministicScores } from "./deterministic";
import { normalizeTags } from "./tag-normalizer";
import type { RequestBudget } from "./request-budget";
import { upsertAndLinkTags } from "@/lib/pipeline/tags/resolve";

export interface ClaimedRepo {
  id: string;
  github_id: number;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  license: string | null;
  default_branch: string;
  stars: number;
  forks: number;
  watchers: number;
  last_commit_at: string;
  github_created_at: string;
  github_pushed_at: string;
  readme_sha: string | null;
  capabilities: {
    has_package_json?: boolean;
    has_readme?: boolean;
    vibecoding_tools?: string[];
    tech_stack_slugs?: string[];
  };
  assets_extracted_at: string | null;
}

export type ScoreOutcome =
  | { status: "published" | "scored" | "needs_review" }
  | { status: "skipped"; reason: "schema_error" | "server_error" | "readme_fetch" };

interface ScoreRepoDeps {
  gemini: GeminiClient;
  budget: RequestBudget;
  isRescore: boolean;
}

export async function scoreRepo(
  ctx: JobContext,
  repo: ClaimedRepo,
  deps: ScoreRepoDeps,
): Promise<ScoreOutcome> {
  // 1. Load README (if present) + file tree + package.json
  let readmeContent = "";
  if (repo.capabilities.has_readme !== false) {
    try {
      readmeContent = await fetchReadme(ctx.db, repo.owner, repo.name);
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionError) {
        readmeContent = "";  // treat as no-readme path
      } else {
        return { status: "skipped", reason: "readme_fetch" };
      }
    }
  }

  const fileTree = await fetchFileTree(ctx.db, repo);
  const packageJsonContent = await fetchPackageJsonIfPresent(ctx.db, repo);
  const repoAssetCount = await countAssets(ctx.db, repo.id);

  // 2. Deterministic scores
  const det = computeDeterministicScores({
    stars: repo.stars,
    forks: repo.forks,
    watchers: repo.watchers,
    githubCreatedAt: new Date(repo.github_created_at),
    lastCommitAt: new Date(repo.last_commit_at),
    capabilities: repo.capabilities,
    fileTree,
    packageJsonContent,
    repoAssetCount,
    assetsExtractedAt: repo.assets_extracted_at ? new Date(repo.assets_extracted_at) : null,
  });

  // 3. Gemini call
  const sections = readmeContent ? extractReadmeSections(readmeContent) : { content: "", structured: false };
  const prompt = buildScoringPrompt({
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    stars: repo.stars,
    lastCommitIso: repo.last_commit_at,
    license: repo.license,
    techStackSlugs: repo.capabilities.tech_stack_slugs ?? [],
    vibecodingToolSlugs: repo.capabilities.vibecoding_tools ?? [],
    hasReadme: Boolean(readmeContent),
    hasPackageJson: Boolean(packageJsonContent),
    readmeSections: sections.content,
  });

  let llmResult: LlmScores;
  try {
    const response = await deps.gemini.score(
      {
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        responseSchema: prompt.responseSchema,
        model: SCORING_MODEL,
      },
      deps.budget,
    );
    llmResult = parseLlmResponse(response.data);
  } catch (err) {
    if (err instanceof GeminiContentFilterError) {
      // Route to needs_review via apply_score_result with weak evidence
      await applyWithWeakEvidence(ctx, repo, det, deps.isRescore, prompt.version);
      return { status: "needs_review" };
    }
    if (err instanceof SchemaValidationError) {
      return { status: "skipped", reason: "schema_error" };
    }
    // Server/rate-limit: let caller decide (they bubble up or halt)
    throw err;
  }

  // 4. Merge code_health (det 60% + llm 40%) + build canonical tag inputs
  const mergedCodeHealth = det.code_health_score_deterministic * 0.6 + llmResult.codeHealthReadme * 0.4;

  const { canonical, freeform } = normalizeTags(
    llmResult.canonicalTags,
    llmResult.novelTags,
  );

  // Resolve canonical slugs → tag row IDs (side-effect: inserts missing)
  const tagInputs = canonical.map((slug) => ({
    slug,
    kind: "feature" as const,
    confidence: 0.8,  // LLM confidence proxy
    source: "auto_llm" as const,
  }));
  await upsertAndLinkTags(ctx.db, repo.id, tagInputs);

  const { data: canonicalRows } = await ctx.db
    .from("tags")
    .select("id, slug")
    .in("slug", canonical);
  const canonicalTagIds = (canonicalRows ?? []).map((r) => r.id);
  const canonicalConfidences = (canonicalRows ?? []).map(() => 0.8);

  // 5. apply_score_result RPC
  const { data: statusResult, error: rpcErr } = await ctx.db.rpc("apply_score_result", {
    p_repo_id: repo.id,
    p_documentation_score: llmResult.documentation,
    p_code_health_score: mergedCodeHealth,
    p_maintenance_score: det.maintenance_score,
    p_popularity_score: det.popularity_score,
    p_visual_preview_score: det.visual_preview_score,
    p_category: llmResult.category,
    p_canonical_tag_ids: canonicalTagIds,
    p_canonical_confidences: canonicalConfidences,
    p_freeform_tags: freeform,
    p_rationale: {
      documentation: llmResult.documentationRationale,
      code_health_readme: llmResult.codeHealthRationale,
    },
    p_evidence_strength: llmResult.evidenceStrength,
    p_prompt_version: prompt.version,
    p_model: SCORING_MODEL,
    p_run_id: ctx.runId,
    p_is_rescore: deps.isRescore,
  });

  if (rpcErr) throw new Error(`apply_score_result failed: ${rpcErr.message}`);

  return { status: (statusResult as "published" | "scored" | "needs_review") ?? "scored" };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (DB + GitHub fetches + type narrowing)
// ─────────────────────────────────────────────────────────────────────

interface LlmScores {
  documentation: number;
  documentationRationale: string;
  codeHealthReadme: number;
  codeHealthRationale: string;
  category:
    | "saas" | "ecommerce" | "dashboard" | "landing_page" | "ai_tool"
    | "utility" | "game" | "portfolio" | "blog" | "chatbot" | "mobile_app" | "other";
  canonicalTags: readonly string[];
  novelTags: readonly string[];
  evidenceStrength: "strong" | "partial" | "weak";
}

function parseLlmResponse(data: unknown): LlmScores {
  if (typeof data !== "object" || data === null) {
    throw new SchemaValidationError("response not an object", data);
  }
  const d = data as Record<string, any>;
  return {
    documentation: d.documentation.value,
    documentationRationale: d.documentation.rationale,
    codeHealthReadme: d.code_health_readme.value,
    codeHealthRationale: d.code_health_readme.rationale,
    category: d.category,
    canonicalTags: Array.isArray(d.feature_tags_canonical) ? d.feature_tags_canonical : [],
    novelTags: Array.isArray(d.feature_tags_novel) ? d.feature_tags_novel : [],
    evidenceStrength: d.evidence_strength,
  };
}

async function fetchReadme(db: SupabaseClient, owner: string, repo: string): Promise<string> {
  const { data } = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    { scope: "rest" },
    db,
  );
  const payload = data as { content?: string; encoding?: string } | null;
  if (!payload?.content) return "";
  const clean = payload.content.replace(/\n/g, "");
  return Buffer.from(clean, "base64").toString("utf-8");
}

async function fetchFileTree(
  db: SupabaseClient,
  repo: ClaimedRepo,
): Promise<{ path: string; type: "file" | "dir" }[]> {
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(repo.default_branch)}`,
      { scope: "rest" },
      db,
    );
    const payload = data as { tree?: { path: string; type: string }[] } | null;
    if (!payload?.tree) return [];
    return payload.tree
      .filter((e) => typeof e.path === "string")
      .map((e) => ({ path: e.path, type: e.type === "tree" ? "dir" : "file" }));
  } catch {
    return [];
  }
}

async function fetchPackageJsonIfPresent(
  db: SupabaseClient,
  repo: ClaimedRepo,
): Promise<string | null> {
  if (repo.capabilities.has_package_json !== true) return null;
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/package.json`,
      { scope: "rest" },
      db,
    );
    const payload = data as { content?: string } | null;
    if (!payload?.content) return null;
    return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function countAssets(
  db: SupabaseClient,
  repoId: string,
): Promise<{ gif: number; image: number }> {
  const { data } = await db
    .from("repo_assets")
    .select("kind")
    .eq("repo_id", repoId);
  const counts = { gif: 0, image: 0 };
  for (const row of data ?? []) {
    if (row.kind === "readme_gif") counts.gif += 1;
    else if (row.kind === "readme_image") counts.image += 1;
  }
  return counts;
}

async function applyWithWeakEvidence(
  ctx: JobContext,
  repo: ClaimedRepo,
  det: ReturnType<typeof computeDeterministicScores>,
  isRescore: boolean,
  promptVersion: string,
): Promise<void> {
  const { error } = await ctx.db.rpc("apply_score_result", {
    p_repo_id: repo.id,
    p_documentation_score: 1,
    p_code_health_score: det.code_health_score_deterministic,
    p_maintenance_score: det.maintenance_score,
    p_popularity_score: det.popularity_score,
    p_visual_preview_score: det.visual_preview_score,
    p_category: "other",
    p_canonical_tag_ids: [],
    p_canonical_confidences: [],
    p_freeform_tags: [],
    p_rationale: { content_filter: true },
    p_evidence_strength: "weak",
    p_prompt_version: promptVersion,
    p_model: SCORING_MODEL,
    p_run_id: ctx.runId,
    p_is_rescore: isRescore,
  });
  if (error) throw new Error(`apply_score_result (weak) failed: ${error.message}`);
}
```

- [ ] **Step 7.2:** Commit (no dedicated unit test — behavior verified end-to-end in integration tests):

```bash
git add lib/pipeline/scoring/score-repo.ts
git commit -m "feat(pipeline): scoreRepo per-repo orchestrator"
```

---

## Task 8 — Score + rescore + prune jobs

**Dependencies:** Task 7

**Files:**
- Create: `lib/pipeline/jobs/score.ts`
- Create: `lib/pipeline/jobs/rescore.ts`
- Create: `lib/pipeline/jobs/prune.ts`
- Create: `lib/pipeline/jobs/__fixtures__/bad-score-service-import.ts`

### 8.1 score.ts

- [ ] **Step 8.1.1:** Create `lib/pipeline/jobs/score.ts`:

```typescript
// Daily scoring job. Resets stuck rows, claims pending batch, invokes
// scoreRepo per repo via ctx.spawn for per-repo observability.

import { env } from "@/lib/env";
import { GeminiClient } from "@/lib/pipeline/gemini/client";
import { GeminiRateLimitError } from "@/lib/pipeline/gemini/errors";
import { RequestBudget } from "@/lib/pipeline/scoring/request-budget";
import { scoreRepo, type ClaimedRepo } from "@/lib/pipeline/scoring/score-repo";
import {
  recordScoreMetrics,
  type ScoreJobMetrics,
} from "@/lib/pipeline/metrics/scoring-metrics";
import type { JobContext, JobOutput } from "@/lib/types/jobs";

export interface ScoreJobInput {
  readonly batchSize?: number;
  readonly mode?: "score" | "rescore";
}

export interface ScoreJobOutput extends JobOutput {
  repos_scored: number;
  repos_stuck_reset: number;
  budget_exhausted: boolean;
}

export async function scoreJob(
  ctx: JobContext,
  input: ScoreJobInput = {},
): Promise<ScoreJobOutput> {
  const batchSize = input.batchSize ?? 50;
  const isRescore = input.mode === "rescore";

  // 1. Reaper
  const { data: stuckCount } = await ctx.db.rpc("reset_stuck_scoring_repos");
  const stuckReset = typeof stuckCount === "number" ? stuckCount : 0;

  // 2. Budget
  const budget = new RequestBudget({
    maxCalls: isRescore ? 2000 : 500,
    maxCostUsd: 5.0,
  });

  // 3. Claim
  const { data: claimedRaw, error: claimErr } = await ctx.db.rpc(
    "claim_pending_repos",
    { p_limit: batchSize },
  );
  if (claimErr) throw new Error(`claim_pending_repos failed: ${claimErr.message}`);
  const claimed = (claimedRaw ?? []) as ClaimedRepo[];

  const metrics: ScoreJobMetrics = {
    repos_claimed: claimed.length,
    repos_scored: 0,
    repos_published: 0,
    repos_gated: 0,
    repos_needs_review: 0,
    repos_skipped_schema: 0,
    repos_skipped_server_error: 0,
    repos_skipped_readme_fetch: 0,
    repos_stuck_reset: stuckReset,
    gemini_calls: 0,
    gemini_input_tokens: 0,
    gemini_output_tokens: 0,
    gemini_429_count: 0,
    cost_usd: 0,
    budget_exhausted: false,
    avg_latency_ms: 0,
  };

  if (claimed.length === 0) {
    recordScoreMetrics(ctx, metrics);
    return {
      repos_scored: 0,
      repos_stuck_reset: stuckReset,
      budget_exhausted: false,
    };
  }

  const gemini = new GeminiClient();
  const latencies: number[] = [];

  // 4. Per-repo via ctx.spawn (child runs for observability)
  for (const repo of claimed) {
    if (!budget.canProceed()) {
      metrics.budget_exhausted = true;
      // Remaining claimed repos revert to pending so next cron picks them up
      await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      continue;
    }

    const t0 = Date.now();
    try {
      const outcome = await ctx.spawn(
        "score-repo",
        { repo_id: repo.id, owner: repo.owner, name: repo.name },
        async (childCtx) => {
          return await scoreRepo(childCtx, repo, {
            gemini,
            budget,
            isRescore,
          });
        },
      );

      metrics.repos_scored += 1;
      if (outcome.status === "published") metrics.repos_published += 1;
      else if (outcome.status === "scored") metrics.repos_gated += 1;
      else if (outcome.status === "needs_review") metrics.repos_needs_review += 1;
      else if (outcome.status === "skipped" && outcome.reason === "schema_error") {
        metrics.repos_skipped_schema += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      } else if (outcome.status === "skipped" && outcome.reason === "server_error") {
        metrics.repos_skipped_server_error += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      } else if (outcome.status === "skipped" && outcome.reason === "readme_fetch") {
        metrics.repos_skipped_readme_fetch += 1;
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
      }
    } catch (err) {
      if (err instanceof GeminiRateLimitError) {
        metrics.gemini_429_count += 1;
        // Revert remaining + halt
        await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
        throw err;
      }
      // Unknown error — revert this repo, continue batch
      await ctx.db.from("repos").update({ status: "pending" }).eq("id", repo.id);
    } finally {
      latencies.push(Date.now() - t0);
    }
  }

  const state = budget.state();
  metrics.gemini_calls = state.calls;
  metrics.cost_usd = state.costUsd;
  metrics.budget_exhausted = state.exhausted;
  metrics.avg_latency_ms =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

  recordScoreMetrics(ctx, metrics);

  return {
    repos_scored: metrics.repos_scored,
    repos_stuck_reset: stuckReset,
    budget_exhausted: metrics.budget_exhausted,
  };
}
```

### 8.2 rescore.ts

- [ ] **Step 8.2.1:** Create `lib/pipeline/jobs/rescore.ts`:

```typescript
// Monthly rescore job. Selects repos whose stored scoring_prompt_version
// differs from current, OR whose scored_at > 30 days.
//
// Key difference from score.ts: candidates come from a JOIN on repo_scores,
// not from status='pending'. We transition qualifying repos to status='scoring'
// manually (no claim RPC) so the rest of the flow matches.

import { SCORING_PROMPT_VERSION } from "@/lib/pipeline/gemini/scoring-prompt";
import type { JobContext, JobOutput } from "@/lib/types/jobs";
import { scoreJob } from "./score";

export interface RescoreJobInput {
  readonly batchSize?: number;
}

export interface RescoreJobOutput extends JobOutput {
  candidates_found: number;
  repos_scored: number;
  drain_mode: boolean;
}

export async function rescoreJob(
  ctx: JobContext,
  input: RescoreJobInput = {},
): Promise<RescoreJobOutput> {
  const batchSize = input.batchSize ?? 200;
  const drainMode = false;  // reserved for env-gated mode in cron route

  // Find candidates
  const { data: candidates, error: candErr } = await ctx.db
    .from("repo_scores")
    .select("repo_id, scoring_prompt_version, scored_at")
    .eq("is_latest", true);
  if (candErr) throw new Error(`rescore candidate query failed: ${candErr.message}`);

  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const targetIds: string[] = [];
  for (const row of candidates ?? []) {
    const versionMismatch = row.scoring_prompt_version !== SCORING_PROMPT_VERSION;
    const stale = row.scored_at ? Date.parse(row.scored_at) < thirtyDaysAgo : true;
    if (versionMismatch || stale) {
      targetIds.push(row.repo_id);
      if (targetIds.length >= batchSize) break;
    }
  }

  if (targetIds.length === 0) {
    return { candidates_found: 0, repos_scored: 0, drain_mode: drainMode };
  }

  // Transition to 'scoring' so score.ts's claim RPC doesn't re-claim them
  // and refresh.ts doesn't touch them mid-scoring
  await ctx.db.from("repos").update({ status: "scoring" }).in("id", targetIds);

  // Delegate per-repo work to scoreJob logic (mode='rescore')
  const result = await scoreJob(ctx, { batchSize: targetIds.length, mode: "rescore" });

  return {
    candidates_found: targetIds.length,
    repos_scored: result.repos_scored,
    drain_mode: drainMode,
  };
}
```

### 8.3 prune.ts

- [ ] **Step 8.3.1:** Create `lib/pipeline/jobs/prune.ts`:

```typescript
// Weekly retention cron: delete successful pipeline_runs older than 90 days.
// Failed runs are retained indefinitely for postmortem analysis.

import type { JobContext, JobOutput } from "@/lib/types/jobs";

export interface PruneJobOutput extends JobOutput {
  rows_deleted: number;
}

export async function pruneJob(ctx: JobContext): Promise<PruneJobOutput> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await ctx.db
    .from("pipeline_runs")
    .delete()
    .lt("started_at", cutoff)
    .eq("status", "success")
    .select("id");

  if (error) throw new Error(`prune delete failed: ${error.message}`);

  const deleted = (data ?? []).length;
  ctx.metric("rows_deleted", deleted);
  return { rows_deleted: deleted };
}
```

### 8.4 Negative fixture

- [ ] **Step 8.4.1:** Create `lib/pipeline/jobs/__fixtures__/bad-score-service-import.ts`:

```typescript
// Intentionally violates Foundation rule F4 (pipeline jobs must use ctx.db).
// dep-cruiser should flag this import via the pipeline-jobs-use-ctx-db-only rule.
// Part of the lint:neg:depcruise npm script to prove the rule is alive.

import { createServiceClient } from "@/lib/db/service-client";

export const _BAD_IMPORT_VIOLATION_FIXTURE = createServiceClient;
```

- [ ] **Step 8.4.2:** Update `package.json` `lint:neg:depcruise` script to also test this fixture:

Current:
```json
"lint:neg:depcruise": "! depcruise -c dependency-cruiser.cjs lib/pipeline/__fixtures__/bad-pipeline-import.ts 2>/dev/null"
```

New:
```json
"lint:neg:depcruise": "! depcruise -c dependency-cruiser.cjs lib/pipeline/__fixtures__/bad-pipeline-import.ts 2>/dev/null && ! depcruise -c dependency-cruiser.cjs lib/pipeline/jobs/__fixtures__/bad-score-service-import.ts 2>/dev/null"
```

- [ ] **Step 8.5:** Run lint and tests to verify:

```bash
pnpm lint
pnpm lint:neg
pnpm test:unit
```

Expected: `lint` passes, both negative fixtures trigger errors (inverted via `!`), unit tests unchanged.

- [ ] **Step 8.6:** Commit:

```bash
git add lib/pipeline/jobs/ package.json
git commit -m "feat(pipeline): score + rescore + prune jobs, negative fixture for F4 rule"
```

---

## Task 9 — Cron routes + vercel.json

**Dependencies:** Task 8

**Files:**
- Create: `app/api/cron/score/route.ts`
- Create: `app/api/cron/rescore/route.ts`
- Create: `app/api/cron/prune/route.ts`
- Modify: `vercel.json`

- [ ] **Step 9.1:** Create `app/api/cron/score/route.ts`:

```typescript
import { env } from "@/lib/env";
import { scoreJob } from "@/lib/pipeline/jobs/score";
import { runJob } from "@/lib/pipeline/runJob";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-score", {}, (ctx) => scoreJob(ctx));
  return Response.json(result);
}
```

- [ ] **Step 9.2:** Create `app/api/cron/rescore/route.ts`:

```typescript
import { env } from "@/lib/env";
import { rescoreJob } from "@/lib/pipeline/jobs/rescore";
import { runJob } from "@/lib/pipeline/runJob";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-rescore", {}, (ctx) => rescoreJob(ctx));
  return Response.json(result);
}
```

- [ ] **Step 9.3:** Create `app/api/cron/prune/route.ts`:

```typescript
import { env } from "@/lib/env";
import { pruneJob } from "@/lib/pipeline/jobs/prune";
import { runJob } from "@/lib/pipeline/runJob";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("pipeline-prune", {}, (ctx) => pruneJob(ctx));
  return Response.json(result);
}
```

- [ ] **Step 9.4:** Update `vercel.json`:

Current content:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/discover", "schedule": "0 3 * * *" },
    { "path": "/api/cron/refresh", "schedule": "0 4 * * 0" },
    { "path": "/api/cron/dormant", "schedule": "0 5 1 * *" }
  ]
}
```

New content:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/discover", "schedule": "0 3 * * *" },
    { "path": "/api/cron/score",    "schedule": "30 3 * * *" },
    { "path": "/api/cron/refresh",  "schedule": "0 4 * * 0" },
    { "path": "/api/cron/prune",    "schedule": "0 5 * * 0" },
    { "path": "/api/cron/dormant",  "schedule": "0 5 1 * *" },
    { "path": "/api/cron/rescore",  "schedule": "0 3 2 * *" }
  ]
}
```

- [ ] **Step 9.5:** Verify lint passes (dep-cruiser carve-out for cron routes already covers score/rescore/prune):

```bash
pnpm lint
```

- [ ] **Step 9.6:** Commit:

```bash
git add app/api/cron/ vercel.json
git commit -m "feat(cron): score (daily) + rescore (monthly) + prune (weekly) routes"
```

---

## Task 10 — Integration tests (batch)

**Dependencies:** Task 9 (all modules in place)

**Files:**
- Create: `tests/integration/pipeline/apply-score-result-rpc.test.ts`
- Create: `tests/integration/pipeline/claim-pending-rpc.test.ts`
- Create: `tests/integration/pipeline/reset-stuck-rpc.test.ts`
- Create: `tests/integration/pipeline/score-job.test.ts`
- Create: `tests/integration/pipeline/rescore-job.test.ts`
- Create: `tests/integration/pipeline/prune-job.test.ts`
- Create: `tests/fixtures/gemini-responses/happy.json`
- Create: `tests/fixtures/gemini-responses/schema-bad.json`
- Create: `tests/fixtures/gemini-responses/schema-semantic-garbage.json`
- Create: `tests/fixtures/gemini-responses/content-filter.json`

Due to length, the full test files are sketched here. The executing engineer should read the spec (§7) + existing integration tests (`tests/integration/pipeline/discover-job.test.ts`) as templates.

### 10.1 Gemini response fixtures

- [ ] **Step 10.1.1:** Create `tests/fixtures/gemini-responses/happy.json`:

```json
{
  "documentation": { "value": 4, "rationale": "README has clear Features + Getting Started sections." },
  "code_health_readme": { "value": 3, "rationale": "Mentions tests, minimal code examples." },
  "category": "saas",
  "feature_tags_canonical": ["auth", "payments", "dark_mode"],
  "feature_tags_novel": ["whitelabeling"],
  "evidence_strength": "strong"
}
```

- [ ] **Step 10.1.2:** Create the other three fixtures similarly (see spec §7.3). `schema-bad.json` omits `evidence_strength`; `schema-semantic-garbage.json` has all-1 scores + empty tags + `weak` evidence; `content-filter.json` is an empty object (simulates Gemini filter response).

### 10.2 apply-score-result-rpc.test.ts

- [ ] **Step 10.2.1:** Create `tests/integration/pipeline/apply-score-result-rpc.test.ts` covering:
  - is_latest invariant: after RPC, exactly one row for a given repo_id has `is_latest=true`
  - Grandfather: published + rescore-below-gate keeps status='published', stamps grandfathered_at
  - First-time below gate + partial evidence → status='needs_review'
  - Canonical tag upsert adds repo_tags with source='auto_llm'
  - tags_freeform array populated with novel slugs, respects 20-cap

### 10.3 claim-pending-rpc.test.ts

- [ ] **Step 10.3.1:** Create `tests/integration/pipeline/claim-pending-rpc.test.ts`:
  - Seed 5 pending repos
  - First claim(3) returns 3 rows, all transitioned to `status='scoring'`
  - Second claim(3) returns the remaining 2 (no duplicates)
  - Third claim(3) returns empty array

### 10.4 reset-stuck-rpc.test.ts

- [ ] **Step 10.4.1:** Create `tests/integration/pipeline/reset-stuck-rpc.test.ts`:
  - Seed repo with status='scoring', updated_at = now() - 20 minutes → reset_stuck reverts to pending
  - Seed repo with status='scoring', updated_at = now() - 5 minutes → reset_stuck leaves it alone
  - Seed repo with status='pending' → reset_stuck doesn't touch

### 10.5 score-job.test.ts

- [ ] **Step 10.5.1:** Create `tests/integration/pipeline/score-job.test.ts` with mocked Gemini:
  - Mock `fetch` globally. Route api.github.com calls to GitHub fixtures; route `generativelanguage.googleapis.com` calls to `happy.json` fixture
  - Seed 2 pending repos + GitHub tokens
  - Run `runJob('test-score', {}, ctx => scoreJob(ctx, { batchSize: 5 }))`
  - Assert:
    - Both repos transitioned to `status='published'` (happy path)
    - repo_scores row per repo with is_latest=true
    - repo_tags populated with canonical feature tags
    - `pipeline_runs` parent row has child rows with `input->>'repo_id'` set

### 10.6 rescore-job.test.ts

- [ ] **Step 10.6.1:** Create `tests/integration/pipeline/rescore-job.test.ts`:
  - Seed repo with status='published' and repo_scores version='0.9.0' (old)
  - Run rescoreJob, mock Gemini happy response
  - Assert: new repo_scores row with current version, old row's is_latest=false, status stays 'published'

### 10.7 prune-job.test.ts

- [ ] **Step 10.7.1:** Create `tests/integration/pipeline/prune-job.test.ts`:
  - Seed pipeline_runs: one success 100d old, one success 30d old, one failed 100d old
  - Run pruneJob
  - Assert: the 100d-old success row deleted; 30d-old success and 100d-old failed retained

- [ ] **Step 10.8:** Run tests (Docker required):

```bash
pnpm test:integration
```

Expected: all pass. If Docker unavailable, document skip + manual verification.

- [ ] **Step 10.9:** Commit:

```bash
git add tests/integration/pipeline/ tests/fixtures/gemini-responses/
git commit -m "test(pipeline): integration tests for scoring RPCs + jobs + Gemini fixtures"
```

---

## Task 11 — SQL snippets + CI validation

**Dependencies:** Task 2 (RPCs), Task 10 (schema fully populated)

**Files:**
- Create: `supabase/snippets/pending-too-long.sql`
- Create: `supabase/snippets/gated-this-week.sql`
- Create: `supabase/snippets/rate-limit-hit.sql`
- Create: `supabase/snippets/scores-near-gate.sql`
- Create: `supabase/snippets/repo-timeline.sql`
- Create: `supabase/snippets/freeform-tag-frequency.sql`
- Modify: `.github/workflows/ci.yml` (snippet validation step)

- [ ] **Step 11.1:** Create `supabase/snippets/pending-too-long.sql`:

```sql
-- Repos stuck in 'pending' for more than 3 days.
-- Usage: replace :n_days if you want a different window.
SELECT id, owner || '/' || name AS slug, updated_at, 
       now() - updated_at AS age
FROM public.repos
WHERE status = 'pending'
  AND updated_at < now() - interval '3 days'
ORDER BY updated_at ASC
LIMIT 50;
```

- [ ] **Step 11.2:** Create `supabase/snippets/gated-this-week.sql`:

```sql
-- Repos that landed in 'scored' or 'needs_review' this week.
-- For manual-review queue surfacing in MVP.
SELECT id, owner || '/' || name AS slug, status, updated_at
FROM public.repos
WHERE status IN ('scored', 'needs_review')
  AND updated_at >= date_trunc('week', now())
ORDER BY updated_at DESC
LIMIT 100;
```

- [ ] **Step 11.3:** Create `supabase/snippets/rate-limit-hit.sql`:

```sql
-- Pipeline runs that hit Gemini rate limiting in the last 7 days.
-- A non-zero count here = we're approaching quota ceiling.
SELECT id, job_name, started_at, metrics->>'gemini_429_count' AS count_429,
       metrics->>'gemini_calls' AS calls_made
FROM public.pipeline_runs
WHERE started_at > now() - interval '7 days'
  AND (metrics->>'gemini_429_count')::int > 0
ORDER BY started_at DESC;
```

- [ ] **Step 11.4:** Create `supabase/snippets/scores-near-gate.sql`:

```sql
-- Repos with total_score between 2.3 and 2.7 — candidates for
-- manual review (a bump or cut could flip their marketplace status).
SELECT r.id, r.owner || '/' || r.name AS slug, r.status,
       rs.total_score, rs.documentation_score, rs.visual_preview_score,
       rs.evidence_strength
FROM public.repos r
JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest
WHERE rs.total_score BETWEEN 2.3 AND 2.7
ORDER BY rs.total_score DESC
LIMIT 100;
```

- [ ] **Step 11.5:** Create `supabase/snippets/repo-timeline.sql`:

```sql
-- Full timeline for a specific repo — pipeline_runs and score history.
-- Usage: bind :repo_id to a specific UUID.
WITH runs AS (
  SELECT started_at AS t, 'run:' || job_name || '/' || status AS event, metrics
  FROM public.pipeline_runs
  WHERE input->>'repo_id' = :repo_id
)
, scores AS (
  SELECT scored_at AS t,
         'score:' || total_score::text || '/' || scoring_prompt_version AS event,
         NULL::jsonb AS metrics
  FROM public.repo_scores
  WHERE repo_id = :repo_id::uuid
)
SELECT * FROM runs
UNION ALL SELECT * FROM scores
ORDER BY t DESC
LIMIT 50;
```

- [ ] **Step 11.6:** Create `supabase/snippets/freeform-tag-frequency.sql`:

```sql
-- Frequency of novel (non-canonical) feature tag slugs in use.
-- Use this to identify tags that should be promoted to the canonical
-- seed enum. If a slug appears in >20 repos, consider adding it to
-- lib/pipeline/scoring/seed-feature-tags.ts + migration 4.
SELECT tag, count(*) AS repo_count,
       min(r.updated_at) AS first_seen,
       max(r.updated_at) AS last_seen
FROM public.repos r, unnest(r.tags_freeform) AS tag
GROUP BY tag
ORDER BY repo_count DESC
LIMIT 100;
```

- [ ] **Step 11.7:** Add snippet validation to CI. Modify `.github/workflows/ci.yml` — inside the `db-integration` job, after "Reset database" step:

```yaml
      - name: Validate SQL snippets compile against schema
        run: |
          set -euo pipefail
          for f in supabase/snippets/*.sql; do
            # Substitute placeholders with dummy values so PREPARE parses
            sed 's/:repo_id/'\''00000000-0000-0000-0000-000000000000'\''/g; s/:n_days/3/g' "$f" \
              | docker exec -i supabase_db_VibeShelf psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'PREPARE s AS $$' -f - -c 'DEALLOCATE s'
          done
```

Exact Docker container name depends on Supabase CLI version. Alternative: use `supabase db execute --file` if the CLI supports it.

- [ ] **Step 11.8:** Commit:

```bash
git add supabase/snippets/ .github/workflows/ci.yml
git commit -m "feat(snippets): 6 operator SQL queries + CI validation step"
```

---

## Task 12 — Documentation updates

**Dependencies:** All previous

**Files:**
- Modify: `docs/architecture/open-questions.md` (resolve Q-05, update Q-06 status)

- [ ] **Step 12.1:** Update `docs/architecture/open-questions.md`:

Replace Q-05 section with:

```markdown
## Q-05. Gemini scoring throughput realism — RESOLVED in sub-project #3

**Status:** Resolved 2026-04-14. See `docs/superpowers/specs/2026-04-14-evaluation-classification-design.md`.

**Resolutions:**
1. Concurrency: sequential per-run with implicit rate pacing via GitHub token pool. Paid tier 1000 RPM is 2+ orders of magnitude above MVP scale (20-50 repos/day).
2. Malformed README: `has_readme=false` path → metadata-only Gemini call with `documentation_score=0`.
3. Manual review queue: `status='needs_review'` state + `supabase/snippets/` operator queries. Full UI deferred.
4. Prompt version rollout: `SCORING_PROMPT_VERSION` semver + RESCORE_DRAIN_MODE env flag for major-version migrations.
```

Update Q-06 to note partial progress:

```markdown
**Update 2026-04-14:** Sub-project #3 ships `ScoreJobMetrics` TypeScript schema + 6 operator SQL snippets + `gemini_429_count` threshold documentation. Full automated alerting still deferred — re-open before first production launch.
```

Update revision log:

```markdown
- **2026-04-14** — Sub-project #3 (evaluation + classification) shipped. Q-05 resolved. Q-06 partially addressed (metrics schema + snippets; alerting pending).
```

- [ ] **Step 12.2:** Commit:

```bash
git add docs/architecture/open-questions.md
git commit -m "docs: mark Q-05 resolved in sub-project #3 — evaluation pipeline live"
```

---

## Task 13 — Final verification + PR

**Dependencies:** All previous tasks

- [ ] **Step 13.1:** Full local verification:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration  # if Docker available
pnpm lint:neg
```

All must pass (or noted skip for integration without Docker).

- [ ] **Step 13.2:** Create PR:

```bash
gh pr create --title "feat: evaluation + classification (sub-project #3)" --body "$(cat <<'EOF'
## Summary

Sub-project #3 of 6 — automated scoring + classification of pending repos via Gemini Flash-Lite.

- **Score** (daily 03:30 UTC): Reaper + status-claim + per-repo scoring via child runs
- **Rescore** (monthly 2nd 03:00 UTC): version-migration + grandfather
- **Prune** (weekly Sun 05:00 UTC): 90-day retention on pipeline_runs.success rows

## Architecture highlights

- Single Gemini call per repo with responseSchema-enforced JSON
- 2 LLM-computed axes (documentation, code_health_readme) + 4 deterministic (popularity, maintenance, code_health_det, visual_preview)
- Atomic `apply_score_result` RPC solves is_latest race + transactional consistency
- Status-claim pattern (`FOR UPDATE SKIP LOCKED`) replaces ineffective advisory locks (Foundation issue #4 side-stepped)
- 30-seed feature-tag enum + tags_freeform array + 20-cap normalization
- Grandfather policy on rescore demotion
- Stuck-state reaper on every score job start
- Cost kill-switch (RequestBudget) per run

## Reviewer findings addressed

14 critical+real findings from 2 reviewer rounds applied (see spec §9 + commit history).

## Followups

- **Issue #4** — Foundation advisory lock documentation
- **Q-06** — Automated alerting (deferred to pre-launch pass)
- **Operational setup** — `GEMINI_API_KEY` in Vercel envs (prod + preview); seed 2-3 GitHub PATs for token pool

## Test plan

- [x] `pnpm lint` clean, dep-cruiser (including new F4 negative fixture) passes
- [x] `pnpm typecheck` clean
- [x] `pnpm test:unit` — all new scoring/deterministic/budget/tag-normalizer tests green
- [ ] `pnpm test:integration` — requires Docker; ~8 new test files
- [ ] Manual smoke test: hit `/api/cron/score` with a seeded pending repo + valid Gemini key

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 13.3:** Push:

```bash
git push -u origin feat/evaluation-classification
```

(Branch name assumes you worked on a feature branch per Foundation pattern.)

---

## Self-Review

**Spec coverage check:**

| Spec section | Task(s) |
|---|---|
| §1 Data flow | Tasks 8, 9 |
| §2 Gemini prompt | Task 5 (prompt builder), Task 4 (seed tags) |
| §3 Schema | Tasks 1, 2 |
| §4 File structure | All library tasks (4-8) |
| §5 Execution model | Tasks 7, 8 |
| §6 Observability | Tasks 8 (metrics), 11 (snippets) |
| §7 Testing | Task 10 |
| §8 Rescore details | Task 8.2 |
| §9 Open questions | Task 12 |
| §10 Dev checklist | PR body (Task 13) |

All spec sections covered by tasks.

**Placeholder scan:** No "TBD", "TODO", "implement later" in plan steps. Sketchy areas flagged explicitly:
- Task 10 fixture files (10.1.2) sketched rather than fully enumerated — executor references spec §7.3
- Task 10 test bodies sketched as assertions — executor reads existing `discover-job.test.ts` as template

**Type consistency:** 
- `ClaimedRepo` shape defined in Task 7 (score-repo.ts), used in Task 8 (score.ts)
- `ScoreJobMetrics` defined in Task 4.6, consumed in Task 8.1
- `SCORING_PROMPT_VERSION` defined in Task 5.4, consumed in Task 8.2 (rescore)
- `apply_score_result` RPC signature (Task 2) matches TypeScript callers (Task 7)

**Method names:**
- `upsertAndLinkTags` (Task 6) — consistent usage in `scoreRepo` (Task 7) and refactored `discover.ts` (Task 6.2.2)
- `extractReadmeSections` (Task 5) — consistent usage in `scoreRepo` (Task 7)

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-evaluation-classification-implementation.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task batch, reviewer between tasks, fast iteration. Matches sub-project #2 pattern.

**2. Inline Execution** — Execute tasks in this session with checkpoints.

**Which approach?**
