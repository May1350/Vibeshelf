CREATE TYPE public.evidence_strength AS ENUM ('strong', 'partial', 'weak');

ALTER TABLE public.repo_scores
  ALTER COLUMN evidence_strength TYPE public.evidence_strength
  USING evidence_strength::public.evidence_strength;
