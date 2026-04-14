-- Repos stuck in 'pending' for more than 3 days.
-- Candidates for operator investigation (fetch failing? budget chronically exhausted?).
SELECT id, owner || '/' || name AS slug, updated_at,
       now() - updated_at AS age
FROM public.repos
WHERE status = 'pending'
  AND updated_at < now() - interval '3 days'
ORDER BY updated_at ASC
LIMIT 50;
