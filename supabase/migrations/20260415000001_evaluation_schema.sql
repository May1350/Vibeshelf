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
