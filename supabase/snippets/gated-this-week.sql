-- Repos that landed in 'scored' or 'needs_review' this week.
-- Surfaces the manual-review queue for MVP operator triage.
SELECT id, owner || '/' || name AS slug, status, updated_at
FROM public.repos
WHERE status IN ('scored', 'needs_review')
  AND updated_at >= date_trunc('week', now())
ORDER BY updated_at DESC
LIMIT 100;
