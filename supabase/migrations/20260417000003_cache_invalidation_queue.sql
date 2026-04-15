-- SP#5 §3.3 — cron-sweep queue for SQL-snippet ops cache invalidation.
-- Direct revalidateTag() covers all API-path writes; this queue only
-- catches out-of-band SQL snippet operations (moderation).

CREATE TABLE public.cache_invalidation_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag         text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  drained_at  timestamptz
);

CREATE INDEX idx_cache_inv_queue_pending
  ON public.cache_invalidation_queue(enqueued_at)
  WHERE drained_at IS NULL;

ALTER TABLE public.cache_invalidation_queue ENABLE ROW LEVEL SECURITY;
-- service-role only; ops snippets run as service_role, API routes don't touch this.
