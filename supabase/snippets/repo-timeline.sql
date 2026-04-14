-- Full timeline for a specific repo — pipeline_runs + score history.
-- Usage: substitute :repo_id with the target UUID before running.
WITH runs AS (
  SELECT started_at AS t,
         'run:' || job_name || '/' || status AS event,
         metrics
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
SELECT t, event, metrics
FROM runs
UNION ALL
SELECT t, event, metrics FROM scores
ORDER BY t DESC
LIMIT 50;
