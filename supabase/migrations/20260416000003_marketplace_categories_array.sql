-- Convert category filter from single value to array (multi-select OR semantics).
-- Repos still have a single `category` column (1:1), but the filter UI lets users
-- pick N categories and shows repos matching ANY of them.
--
-- Approach: drop + recreate the 4 functions that take p_category. Empty/NULL
-- array means "no category filter" (matches the empty-tags convention).

DROP FUNCTION IF EXISTS public.list_repos_no_tags(text, public.repo_category, numeric, text, text, int);
DROP FUNCTION IF EXISTS public.list_repos_with_tags(text, public.repo_category, numeric, text, text, int, text[]);
DROP FUNCTION IF EXISTS public.list_repos_no_tags_count(text, public.repo_category, numeric, text);
DROP FUNCTION IF EXISTS public.list_repos_with_tags_count(text, public.repo_category, numeric, text, text[]);

-- ══════════════════════════════════════════════════════════════════════
-- 2. list_repos_no_tags — page rows, no tag filter.
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_no_tags(
  p_q text,
  p_categories public.repo_category[],
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
    AND (p_categories IS NULL OR coalesce(array_length(p_categories, 1), 0) = 0
         OR r.category = ANY(p_categories))
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
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_with_tags(
  p_q text,
  p_categories public.repo_category[],
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
    AND (p_categories IS NULL OR coalesce(array_length(p_categories, 1), 0) = 0
         OR r.category = ANY(p_categories))
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
-- 4. list_repos_no_tags_count
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_no_tags_count(
  p_q text,
  p_categories public.repo_category[],
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
    AND (p_categories IS NULL OR coalesce(array_length(p_categories, 1), 0) = 0
         OR r.category = ANY(p_categories))
    AND (p_min_score IS NULL OR rs.total_score >= p_min_score)
    AND (p_vibecoding IS NULL OR EXISTS (
      SELECT 1 FROM public.repo_tags rt JOIN public.tags t ON t.id = rt.tag_id
      WHERE rt.repo_id = r.id AND t.kind = 'vibecoding_tool' AND t.slug = p_vibecoding))
    AND (p_q IS NULL OR r.search_vector @@ plainto_tsquery('english', p_q));
  RETURN coalesce(result, 0);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 5. list_repos_with_tags_count
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.list_repos_with_tags_count(
  p_q text,
  p_categories public.repo_category[],
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
    AND (p_categories IS NULL OR coalesce(array_length(p_categories, 1), 0) = 0
         OR r.category = ANY(p_categories))
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

REVOKE ALL ON FUNCTION public.list_repos_no_tags(text, public.repo_category[], numeric, text, text, int) FROM public;
REVOKE ALL ON FUNCTION public.list_repos_with_tags(text, public.repo_category[], numeric, text, text, int, text[]) FROM public;
REVOKE ALL ON FUNCTION public.list_repos_no_tags_count(text, public.repo_category[], numeric, text) FROM public;
REVOKE ALL ON FUNCTION public.list_repos_with_tags_count(text, public.repo_category[], numeric, text, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.list_repos_no_tags(text, public.repo_category[], numeric, text, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_repos_with_tags(text, public.repo_category[], numeric, text, text, int, text[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_repos_no_tags_count(text, public.repo_category[], numeric, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_repos_with_tags_count(text, public.repo_category[], numeric, text, text[]) TO anon, authenticated;
