-- Marketplace RPCs:
--   1. composite type marketplace_repo_row
--   2. list_repos_no_tags              (page rows, no tag filter)
--   3. list_repos_with_tags            (page rows, AND-tag filter)
--   4. list_repos_no_tags_count        (total count for paginator)
--   5. list_repos_with_tags_count      (total count for paginator)
--   6. get_marketplace_facets          (nested jsonb facet map)
--   7. get_repo_detail                 (single repo + scores + tags + assets)
--
-- Invariants baked in (reviewer findings):
--   * LEFT JOIN repo_scores + WHERE rs.id IS NOT NULL  (admin-patch safety, Critical R1.C1)
--   * LEFT JOIN LATERAL hero asset across all 4 kinds  (Real R2.R2)
--       — readme_gif (0) > readme_image (1) > demo_screenshot (2) > ai_generated (3)
--   * popular sort floors window at 30 days              (Real R2.R4)
--   * AND-tag HAVING uses count(DISTINCT t.slug) = array_length(p_tags,1)
--   * Each function: LANGUAGE plpgsql STABLE SECURITY INVOKER (RLS enforced)
--   * GRANT EXECUTE ... TO anon, authenticated (anon client reads through RLS)

-- ══════════════════════════════════════════════════════════════════════
-- 1. Composite row type shared by list variants.
-- ══════════════════════════════════════════════════════════════════════
CREATE TYPE public.marketplace_repo_row AS (
  id uuid,
  owner text,
  name text,
  description text,
  homepage text,
  stars int,
  forks int,
  last_commit_at timestamptz,
  category public.repo_category,
  tags_freeform text[],
  total_score numeric(3,2),
  documentation_score numeric(3,2),
  maintenance_score numeric(3,2),
  popularity_score numeric(3,2),
  code_health_score numeric(3,2),
  visual_preview_score numeric(3,2),
  feature_tags text[],
  tech_stack_tags text[],
  vibecoding_tags text[],
  hero_asset jsonb
);

-- ══════════════════════════════════════════════════════════════════════
-- 2. list_repos_no_tags — page rows, no tag filter.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_no_tags(
  p_q text,
  p_category public.repo_category,
  p_min_score numeric,
  p_vibecoding text,
  p_sort text,
  p_offset int
) RETURNS SETOF public.marketplace_repo_row
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.owner, r.name, r.description, r.homepage, r.stars, r.forks,
    r.last_commit_at, r.category, r.tags_freeform,
    rs.total_score, rs.documentation_score, rs.maintenance_score,
    rs.popularity_score, rs.code_health_score, rs.visual_preview_score,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind = 'feature'), ARRAY[]::text[]) AS feature_tags,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind = 'tech_stack'), ARRAY[]::text[]) AS tech_stack_tags,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool'), ARRAY[]::text[]) AS vibecoding_tags,
    asset.hero
  FROM public.repos r
  LEFT JOIN public.repo_scores rs
    ON rs.repo_id = r.id AND rs.is_latest = true
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'kind', a.kind,
      'external_url', a.external_url,
      'storage_key', a.storage_key,
      'width', a.width,
      'height', a.height,
      'priority', a.priority
    ) AS hero
    FROM public.repo_assets a
    WHERE a.repo_id = r.id
      AND a.kind IN ('readme_gif','readme_image','demo_screenshot','ai_generated')
    ORDER BY
      CASE a.kind
        WHEN 'readme_gif'       THEN 0
        WHEN 'readme_image'     THEN 1
        WHEN 'demo_screenshot'  THEN 2
        WHEN 'ai_generated'     THEN 3
      END,
      a.priority ASC
    LIMIT 1
  ) asset ON true
  WHERE r.status = 'published'
    AND rs.id IS NOT NULL
    AND (p_category IS NULL OR r.category = p_category)
    AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
    AND (p_vibecoding IS NULL OR EXISTS (
      SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
      WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
    AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
  ORDER BY
    CASE WHEN p_sort = 'score'  THEN rs.total_score END DESC NULLS LAST,
    CASE WHEN p_sort = 'recent' THEN r.last_commit_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'popular' THEN
      r.stars::numeric / GREATEST(30, EXTRACT(EPOCH FROM (now() - r.github_created_at)) / 86400)
    END DESC NULLS LAST,
    r.stars DESC
  LIMIT 36 OFFSET p_offset;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 3. list_repos_with_tags — page rows, AND-tag filter.
--    Body is identical to no_tags except for the extra IN subquery
--    enforcing "repo has every requested feature tag".
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_with_tags(
  p_q text,
  p_category public.repo_category,
  p_min_score numeric,
  p_vibecoding text,
  p_sort text,
  p_offset int,
  p_tags text[]
) RETURNS SETOF public.marketplace_repo_row
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.owner, r.name, r.description, r.homepage, r.stars, r.forks,
    r.last_commit_at, r.category, r.tags_freeform,
    rs.total_score, rs.documentation_score, rs.maintenance_score,
    rs.popularity_score, rs.code_health_score, rs.visual_preview_score,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind = 'feature'), ARRAY[]::text[]) AS feature_tags,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind = 'tech_stack'), ARRAY[]::text[]) AS tech_stack_tags,
    coalesce((SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
              FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
              WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool'), ARRAY[]::text[]) AS vibecoding_tags,
    asset.hero
  FROM public.repos r
  LEFT JOIN public.repo_scores rs
    ON rs.repo_id = r.id AND rs.is_latest = true
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'kind', a.kind,
      'external_url', a.external_url,
      'storage_key', a.storage_key,
      'width', a.width,
      'height', a.height,
      'priority', a.priority
    ) AS hero
    FROM public.repo_assets a
    WHERE a.repo_id = r.id
      AND a.kind IN ('readme_gif','readme_image','demo_screenshot','ai_generated')
    ORDER BY
      CASE a.kind
        WHEN 'readme_gif'       THEN 0
        WHEN 'readme_image'     THEN 1
        WHEN 'demo_screenshot'  THEN 2
        WHEN 'ai_generated'     THEN 3
      END,
      a.priority ASC
    LIMIT 1
  ) asset ON true
  WHERE r.status = 'published'
    AND rs.id IS NOT NULL
    AND (p_category IS NULL OR r.category = p_category)
    AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
    AND (p_vibecoding IS NULL OR EXISTS (
      SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
      WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
    AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
    AND r.id IN (
      SELECT rt2.repo_id FROM public.repo_tags rt2
      JOIN public.tags t2 ON t2.id = rt2.tag_id
      WHERE t2.slug = ANY(p_tags) AND t2.kind = 'feature'
      GROUP BY rt2.repo_id
      HAVING count(DISTINCT t2.slug) = array_length(p_tags, 1)
    )
  ORDER BY
    CASE WHEN p_sort = 'score'  THEN rs.total_score END DESC NULLS LAST,
    CASE WHEN p_sort = 'recent' THEN r.last_commit_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'popular' THEN
      r.stars::numeric / GREATEST(30, EXTRACT(EPOCH FROM (now() - r.github_created_at)) / 86400)
    END DESC NULLS LAST,
    r.stars DESC
  LIMIT 36 OFFSET p_offset;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 4. list_repos_no_tags_count — total count matching the same WHERE.
--    Mirrors list_repos_no_tags but drops sort + page + tag aggregates.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_no_tags_count(
  p_q text,
  p_category public.repo_category,
  p_min_score numeric,
  p_vibecoding text
) RETURNS int
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  result int;
BEGIN
  SELECT count(*) INTO result
  FROM public.repos r
  LEFT JOIN public.repo_scores rs
    ON rs.repo_id = r.id AND rs.is_latest = true
  WHERE r.status = 'published'
    AND rs.id IS NOT NULL
    AND (p_category IS NULL OR r.category = p_category)
    AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
    AND (p_vibecoding IS NULL OR EXISTS (
      SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
      WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
    AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q));
  RETURN coalesce(result, 0);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 5. list_repos_with_tags_count — total count with AND tag filter.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_with_tags_count(
  p_q text,
  p_category public.repo_category,
  p_min_score numeric,
  p_vibecoding text,
  p_tags text[]
) RETURNS int
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  result int;
BEGIN
  SELECT count(*) INTO result
  FROM public.repos r
  LEFT JOIN public.repo_scores rs
    ON rs.repo_id = r.id AND rs.is_latest = true
  WHERE r.status = 'published'
    AND rs.id IS NOT NULL
    AND (p_category IS NULL OR r.category = p_category)
    AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
    AND (p_vibecoding IS NULL OR EXISTS (
      SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
      WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
    AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q))
    AND r.id IN (
      SELECT rt2.repo_id FROM public.repo_tags rt2
      JOIN public.tags t2 ON t2.id = rt2.tag_id
      WHERE t2.slug = ANY(p_tags) AND t2.kind = 'feature'
      GROUP BY rt2.repo_id
      HAVING count(DISTINCT t2.slug) = array_length(p_tags, 1)
    );
  RETURN coalesce(result, 0);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 6. get_marketplace_facets — nested jsonb facet counts.
--    Shape: { category: {...}, tag: {...}, vibecoding: {...}, score_bucket: {...} }
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_marketplace_facets() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  result jsonb;
BEGIN
  WITH category_counts AS (
    SELECT 'category'::text AS facet, category::text AS key, count(*)::int AS cnt
    FROM public.repos
    WHERE status = 'published' AND category IS NOT NULL
    GROUP BY category
  ),
  tag_counts AS (
    SELECT 'tag'::text AS facet, t.slug::text AS key, count(DISTINCT r.id)::int AS cnt
    FROM public.tags t
    JOIN public.repo_tags rt ON rt.tag_id = t.id
    JOIN public.repos r ON r.id = rt.repo_id
    WHERE r.status = 'published' AND t.kind = 'feature'
    GROUP BY t.slug
  ),
  vibecoding_counts AS (
    SELECT 'vibecoding'::text AS facet, t.slug::text AS key, count(DISTINCT r.id)::int AS cnt
    FROM public.tags t
    JOIN public.repo_tags rt ON rt.tag_id = t.id
    JOIN public.repos r ON r.id = rt.repo_id
    WHERE r.status = 'published' AND t.kind = 'vibecoding_tool'
    GROUP BY t.slug
  ),
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

-- ══════════════════════════════════════════════════════════════════════
-- 7. get_repo_detail — single repo + scores + tags + assets.
--    Tag aggregates inlined (spec §5.4 left them as ellipses).
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_repo_detail(p_owner text, p_name text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT to_jsonb(r) ||
    jsonb_build_object(
      'scores', to_jsonb(rs),
      'feature_tags', coalesce(
        (SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
         FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
         WHERE rt.repo_id = r.id AND t.kind = 'feature'),
        ARRAY[]::text[]
      ),
      'tech_stack_tags', coalesce(
        (SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
         FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
         WHERE rt.repo_id = r.id AND t.kind = 'tech_stack'),
        ARRAY[]::text[]
      ),
      'vibecoding_tags', coalesce(
        (SELECT array_agg(DISTINCT t.slug ORDER BY t.slug)
         FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
         WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool'),
        ARRAY[]::text[]
      ),
      'assets', coalesce(
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.priority)
         FROM public.repo_assets a WHERE a.repo_id = r.id),
        '[]'::jsonb
      )
    ) INTO result
  FROM public.repos r
  LEFT JOIN public.repo_scores rs ON rs.repo_id = r.id AND rs.is_latest = true
  WHERE r.owner = p_owner AND r.name = p_name AND r.status = 'published';
  RETURN result;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- Grants — anon client reads through RLS; all functions are SECURITY INVOKER.
-- ══════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.list_repos_no_tags(text, public.repo_category, numeric, text, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_no_tags(text, public.repo_category, numeric, text, text, int) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.list_repos_with_tags(text, public.repo_category, numeric, text, text, int, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_with_tags(text, public.repo_category, numeric, text, text, int, text[]) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.list_repos_no_tags_count(text, public.repo_category, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_no_tags_count(text, public.repo_category, numeric, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.list_repos_with_tags_count(text, public.repo_category, numeric, text, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_with_tags_count(text, public.repo_category, numeric, text, text[]) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_marketplace_facets() FROM public;
GRANT EXECUTE ON FUNCTION public.get_marketplace_facets() TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_repo_detail(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_repo_detail(text, text) TO anon, authenticated;
