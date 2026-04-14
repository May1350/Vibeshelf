-- Fix: grandfathered_at belongs on `repos` (it marks the REPO as grandfathered
-- by a rescore), NOT on `repo_scores`. The apply_score_result RPC does
-- `UPDATE public.repos SET grandfathered_at = now() WHERE id = p_repo_id`
-- which fails if the column lives on repo_scores. Caught by integration test
-- `apply-score-result-rpc.test.ts > rescore + published repo + low total → grandfathered`
-- on PR #4 CI run. Migration added in the same PR for fix-forward.

-- Add column to repos
ALTER TABLE public.repos
  ADD COLUMN IF NOT EXISTS grandfathered_at timestamptz;

-- Drop column from repo_scores (was added in 20260415000001 by mistake).
-- Drop is safe: repo_scores is empty in fresh installs (the
-- 20260415000001 DO $$ guard ensures this), and even on prod no application
-- code reads from this column on repo_scores (only the RPC writes — and
-- it's been broken since the RPC's UPDATE targets repos.grandfathered_at).
ALTER TABLE public.repo_scores
  DROP COLUMN IF EXISTS grandfathered_at;
