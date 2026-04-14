-- Marketplace search support — name + description tsvector + partial GIN index.
-- README content NOT included (D4=Y decision); add later if search quality demands.

ALTER TABLE public.repos
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

-- Partial GIN matches the WHERE clause used by list_repos_*
CREATE INDEX idx_repos_search_vector_gin
  ON public.repos USING gin (search_vector)
  WHERE status = 'published';
