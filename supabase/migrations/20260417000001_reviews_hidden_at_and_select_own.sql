-- SP#5 §3.1 — soft-hide column + RLS so authors still see own hidden reviews.

ALTER TABLE public.reviews
  ADD COLUMN hidden_at timestamptz;

CREATE INDEX idx_reviews_visible
  ON public.reviews(repo_id, created_at DESC)
  WHERE hidden_at IS NULL;

-- Replace the public-read policy with one that filters hidden rows.
DROP POLICY IF EXISTS reviews_select_published ON public.reviews;

CREATE POLICY reviews_select_published
  ON public.reviews FOR SELECT TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.repos r
      WHERE r.id = reviews.repo_id
        AND r.status = 'published'
    )
  );

-- Author still sees their own review (even if hidden) so UPDATE/DELETE
-- policies work. Per Reviewer G: RLS UPDATE USING expressions need a
-- SELECT-side read path to evaluate the row.
CREATE POLICY reviews_select_own
  ON public.reviews FOR SELECT TO authenticated
  USING (user_id = auth.uid());
