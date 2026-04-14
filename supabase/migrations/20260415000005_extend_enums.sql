-- repo_category: 4 new values
ALTER TYPE public.repo_category ADD VALUE 'portfolio';
ALTER TYPE public.repo_category ADD VALUE 'blog';
ALTER TYPE public.repo_category ADD VALUE 'chatbot';
ALTER TYPE public.repo_category ADD VALUE 'mobile_app';

-- repo_status: 2 new values ('scoring' intermediate state for claim pattern, 'needs_review' for weak evidence/content filter)
ALTER TYPE public.repo_status ADD VALUE 'scoring';
ALTER TYPE public.repo_status ADD VALUE 'needs_review';

-- repo_tags.source: add 'auto_llm' to distinguish LLM-inferred from rule-based 'auto'
ALTER TABLE public.repo_tags DROP CONSTRAINT IF EXISTS repo_tags_source_check;
ALTER TABLE public.repo_tags ADD CONSTRAINT repo_tags_source_check
  CHECK (source IN ('ai', 'manual', 'review_derived', 'auto', 'auto_llm'));
