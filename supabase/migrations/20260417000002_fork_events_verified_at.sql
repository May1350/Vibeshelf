-- SP#5 §3.2 — async-verify pattern (verified_at NULL = pending).

ALTER TABLE public.fork_events
  ADD COLUMN verified_at timestamptz;

CREATE INDEX idx_fork_events_user_repo_verified
  ON public.fork_events(user_id, repo_id)
  INCLUDE (verified_at, forked_at);
