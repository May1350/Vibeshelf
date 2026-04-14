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
-- claim_repos_by_id
--   Transition a specific list of repo IDs to 'scoring' and return their
--   row data. Used by rescoreJob which pre-selects candidates by
--   scoring_prompt_version mismatch (not by status='pending').
--   Skips any repo that's not in a claimable state (already 'scoring',
--   'removed', etc.) so concurrent jobs don't double-claim.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.claim_repos_by_id(p_ids uuid[])
RETURNS TABLE (
  id                  uuid,
  github_id           bigint,
  owner               text,
  name                text,
  description         text,
  homepage            text,
  license             text,
  default_branch     text,
  stars               int,
  forks               int,
  watchers            int,
  last_commit_at      timestamptz,
  github_created_at   timestamptz,
  github_pushed_at    timestamptz,
  readme_sha          text,
  capabilities        jsonb,
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
    WHERE r.id = ANY(p_ids)
      AND r.status IN ('published', 'scored', 'needs_review', 'dormant')
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

REVOKE ALL ON FUNCTION public.claim_repos_by_id(uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_repos_by_id(uuid[]) TO service_role;

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

  -- Step 2: read current repo state (status + assets_extracted_at for gate).
  -- FOR UPDATE on repos serializes concurrent apply_score_result calls for
  -- the same repo — paired with the is_latest row lock below, this prevents
  -- two RPCs from both seeing is_latest=true and flipping → inserting → violating
  -- the partial unique index idx_repo_scores_one_latest_per_repo.
  SELECT status, assets_extracted_at INTO v_current_status, v_assets_extracted
  FROM public.repos WHERE id = p_repo_id FOR UPDATE;

  -- Step 3: lock the current is_latest row (if any) BEFORE flipping it.
  -- This prevents a concurrent RPC from seeing the same is_latest=true row
  -- after our UPDATE takes effect — they must wait on our transaction.
  PERFORM 1 FROM public.repo_scores
    WHERE repo_id = p_repo_id AND is_latest = true
    FOR UPDATE;

  -- Step 4: flip prior is_latest=false BEFORE inserting new row
  -- (avoids partial unique index violation on idx_repo_scores_one_latest_per_repo)
  UPDATE public.repo_scores
  SET is_latest = false
  WHERE repo_id = p_repo_id AND is_latest = true;

  -- Step 5: insert new repo_scores row
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

  -- Step 6: upsert canonical repo_tags (tag rows themselves are inserted by
  -- lib/pipeline/tags/resolve.ts:resolveTagIds BEFORE this RPC; we only link
  -- them here to preserve the "single atomic write" contract).
  IF array_length(p_canonical_tag_ids, 1) IS NOT NULL THEN
    FOR v_idx IN 1..array_length(p_canonical_tag_ids, 1) LOOP
      INSERT INTO public.repo_tags (repo_id, tag_id, confidence, source)
      VALUES (p_repo_id, p_canonical_tag_ids[v_idx], p_canonical_confidences[v_idx], 'auto_llm')
      ON CONFLICT (repo_id, tag_id) DO UPDATE
        SET confidence = EXCLUDED.confidence, source = 'auto_llm';
    END LOOP;
  END IF;

  -- Step 7: determine next status (publish gate + grandfather)
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

  -- Step 8: update repos with new status + category + tags_freeform
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
