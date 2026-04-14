ALTER TABLE public.repos
  ADD COLUMN tags_freeform text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT tags_freeform_size_cap
    CHECK (array_length(tags_freeform, 1) IS NULL OR array_length(tags_freeform, 1) <= 20);

COMMENT ON COLUMN public.repos.tags_freeform IS
  'LLM-emitted feature tag slugs NOT in canonical seed enum. Monitoring only; NOT used by filter UI. See supabase/snippets/freeform-tag-frequency.sql for analysis.';

CREATE INDEX idx_repos_tags_freeform_gin ON public.repos USING gin (tags_freeform);
