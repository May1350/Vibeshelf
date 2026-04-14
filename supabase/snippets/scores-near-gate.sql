-- Repos with total_score between 2.3 and 2.7 — candidates for
-- manual review. A bump or cut could flip their marketplace visibility.
-- Actionable query: replaces score-distribution (vanity without ground truth).
SELECT r.id, r.owner || '/' || r.name AS slug, r.status,
       rs.total_score, rs.documentation_score, rs.visual_preview_score,
       rs.evidence_strength
FROM public.repos r
JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest
WHERE rs.total_score BETWEEN 2.3 AND 2.7
ORDER BY rs.total_score DESC
LIMIT 100;
