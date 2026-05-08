-- get_marketplace_facets_v2 — query-aware facet counts.
--
-- The original facets RPC was parameter-free and emitted global counts.
-- That misleads users in classic faceted-search UX: the sidebar should show
-- "how many results would match if I add this filter" — i.e. the count for
-- each candidate value, given everything ELSE the user has already chosen.
--
-- For each facet axis, we apply all filters EXCEPT that axis:
--   * category  → exclude p_categories
--   * tag       → exclude p_tags
--   * vibecoding→ exclude p_vibecoding
--   * score     → exclude p_min_score
-- p_q (search) is always applied (it doesn't have its own sidebar facet).
--
-- Returns the same nested jsonb shape as the original so callers swap
-- transparently:
--   { category: {...}, tag: {...}, vibecoding: {...}, score_bucket: {...} }

CREATE OR REPLACE FUNCTION public.get_marketplace_facets_v2(
  p_q          text,
  p_categories public.repo_category[],
  p_tags       text[],
  p_min_score  numeric,
  p_vibecoding text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  result jsonb;
BEGIN
  WITH
  -- Tag-AND predicate factored to keep the per-axis WHERE clauses readable.
  -- repo_id matches p_tags iff every requested tag slug is linked.
  tag_match AS (
    SELECT rt2.repo_id
    FROM public.repo_tags rt2
    JOIN public.tags t2 ON t2.id = rt2.tag_id
    WHERE t2.kind = 'feature' AND t2.slug = ANY(p_tags)
    GROUP BY rt2.repo_id
    HAVING count(DISTINCT t2.slug) = coalesce(array_length(p_tags, 1), 0)
  ),
  -- ── Category counts: drop p_categories, keep tags/min_score/vibecoding/q ──
  category_counts AS (
    SELECT 'category'::text AS facet, r.category::text AS key, count(*)::int AS cnt
    FROM public.repos r
    LEFT JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest = true
    WHERE r.status = 'published'
      AND r.category IS NOT NULL
      AND rs.id IS NOT NULL
      AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
      AND (p_vibecoding IS NULL OR EXISTS (
        SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
        WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
      AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
      AND (array_length(p_tags, 1) IS NULL OR r.id IN (SELECT repo_id FROM tag_match))
    GROUP BY r.category
  ),
  -- ── Tag counts: drop p_tags, keep categories/min_score/vibecoding/q ──
  tag_counts AS (
    SELECT 'tag'::text AS facet, t.slug::text AS key, count(DISTINCT r.id)::int AS cnt
    FROM public.tags t
    JOIN public.repo_tags rt ON rt.tag_id = t.id
    JOIN public.repos r       ON r.id = rt.repo_id
    LEFT JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest = true
    WHERE r.status = 'published'
      AND t.kind = 'feature'
      AND rs.id IS NOT NULL
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
      AND (p_vibecoding IS NULL OR EXISTS (
        SELECT 1 FROM public.repo_tags rt2 JOIN public.tags t2 ON t2.id = rt2.tag_id
        WHERE rt2.repo_id = r.id AND t2.kind = 'vibecoding_tool' AND t2.slug = p_vibecoding))
      AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
    GROUP BY t.slug
  ),
  -- ── Vibecoding counts: drop p_vibecoding, keep categories/tags/min_score/q ──
  vibecoding_counts AS (
    SELECT 'vibecoding'::text AS facet, t.slug::text AS key, count(DISTINCT r.id)::int AS cnt
    FROM public.tags t
    JOIN public.repo_tags rt ON rt.tag_id = t.id
    JOIN public.repos r       ON r.id = rt.repo_id
    LEFT JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest = true
    WHERE r.status = 'published'
      AND t.kind = 'vibecoding_tool'
      AND rs.id IS NOT NULL
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
      AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
      AND (array_length(p_tags, 1) IS NULL OR r.id IN (SELECT repo_id FROM tag_match))
    GROUP BY t.slug
  ),
  -- ── Score buckets: drop p_min_score, keep categories/tags/vibecoding/q ──
  score_buckets AS (
    SELECT 'score_bucket'::text AS facet,
           b.bucket AS key,
           count(*)::int AS cnt
    FROM public.repos r
    JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest = true
    CROSS JOIN LATERAL (VALUES
      ('min_3'::text,   rs.total_score >= 3),
      ('min_4'::text,   rs.total_score >= 4),
      ('min_4_5'::text, rs.total_score >= 4.5)
    ) AS b(bucket, included)
    WHERE r.status = 'published' AND b.included
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_vibecoding IS NULL OR EXISTS (
        SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
        WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
      AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
      AND (array_length(p_tags, 1) IS NULL OR r.id IN (SELECT repo_id FROM tag_match))
    GROUP BY b.bucket
  ),
  unioned AS (
    SELECT * FROM category_counts   UNION ALL
    SELECT * FROM tag_counts        UNION ALL
    SELECT * FROM vibecoding_counts UNION ALL
    SELECT * FROM score_buckets
  )
  SELECT jsonb_object_agg(facet_grouped.facet, facet_grouped.entries) INTO result
  FROM (
    SELECT facet, jsonb_object_agg(key, cnt) AS entries
    FROM unioned
    GROUP BY facet
  ) facet_grouped;
  RETURN coalesce(result, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_marketplace_facets_v2(text, public.repo_category[], text[], numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_marketplace_facets_v2(text, public.repo_category[], text[], numeric, text) TO anon, authenticated;
