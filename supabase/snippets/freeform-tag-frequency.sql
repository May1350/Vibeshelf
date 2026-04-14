-- Frequency of novel (non-canonical) feature tag slugs across repos.
-- Slugs appearing in >20 repos are strong candidates to promote into
-- the canonical SEED_FEATURE_TAG_SLUGS list (lib/pipeline/scoring/
-- seed-feature-tags.ts) + the corresponding migration seed.
SELECT tag,
       count(*) AS repo_count,
       min(r.updated_at) AS first_seen,
       max(r.updated_at) AS last_seen
FROM public.repos r, unnest(r.tags_freeform) AS tag
GROUP BY tag
ORDER BY repo_count DESC
LIMIT 100;
