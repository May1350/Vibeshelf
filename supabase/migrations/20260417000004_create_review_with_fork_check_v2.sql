-- SP#5 §3.5 — v2 RPC: grace-window fork check + 23505 translation.

DROP FUNCTION IF EXISTS public.create_review_with_fork_check(
  uuid, smallint, text, public.vibecoding_tool
);

CREATE OR REPLACE FUNCTION public.create_review_with_fork_check_v2(
  p_repo_id uuid,
  p_rating smallint,
  p_text_body text,
  p_vibecoding_tool public.vibecoding_tool,
  p_image_keys text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_review_id uuid;
  v_forked boolean;
  v_key text;
  v_ordering smallint := 0;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;

  -- Fork-check: either verified OR forked within 30s (grace window).
  SELECT EXISTS (
    SELECT 1 FROM public.fork_events
    WHERE user_id = v_user_id AND repo_id = p_repo_id
      AND (verified_at IS NOT NULL OR forked_at > now() - interval '30 seconds')
  ) INTO v_forked;

  IF NOT v_forked THEN
    RAISE EXCEPTION 'fork_required' USING ERRCODE = 'P0001';
  END IF;

  -- Validate rating bounds (table CHECK does this too, but surface a nicer error).
  IF p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'rating_out_of_range' USING ERRCODE = 'P0001';
  END IF;

  -- Validate ≤5 images.
  IF array_length(p_image_keys, 1) > 5 THEN
    RAISE EXCEPTION 'too_many_images' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.reviews (repo_id, user_id, rating, text_body, vibecoding_tool)
    VALUES (p_repo_id, v_user_id, p_rating, p_text_body, p_vibecoding_tool)
    RETURNING id INTO v_review_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'already_reviewed' USING ERRCODE = 'P0001';
  END;

  -- Insert assets one-at-a-time (per-row enforce_review_asset_limit trigger).
  IF p_image_keys IS NOT NULL THEN
    FOREACH v_key IN ARRAY p_image_keys LOOP
      INSERT INTO public.review_assets (review_id, storage_key, content_type, ordering)
      VALUES (v_review_id, v_key, 'image/*', v_ordering);
      v_ordering := v_ordering + 1;
    END LOOP;
  END IF;

  RETURN v_review_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_review_with_fork_check_v2(
  uuid, smallint, text, public.vibecoding_tool, text[]
) FROM public;

GRANT EXECUTE ON FUNCTION public.create_review_with_fork_check_v2(
  uuid, smallint, text, public.vibecoding_tool, text[]
) TO authenticated;
