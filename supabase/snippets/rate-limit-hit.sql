-- Pipeline runs that hit Gemini rate limiting in the last 7 days.
-- A non-zero count here = approaching quota ceiling; consider tier bump.
--   0      → normal
--   > 5    → warning
--   > 20   → error (quota exhaustion; upgrade needed)
SELECT id, job_name, started_at,
       (metrics->>'gemini_429_count')::int AS count_429,
       (metrics->>'gemini_calls')::int AS calls_made
FROM public.pipeline_runs
WHERE started_at > now() - interval '7 days'
  AND (metrics->>'gemini_429_count')::int > 0
ORDER BY started_at DESC;
