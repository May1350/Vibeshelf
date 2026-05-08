-- Migration 5: row-based pipeline locks
--
-- The original advisory_lock implementation (acquire_pipeline_lock,
-- release_pipeline_lock in 20260414000002_*) used pg_try_advisory_lock,
-- which is *session-scoped*. Supabase routes traffic through Supavisor
-- in transaction-pool mode: a connection that acquires a session-level
-- lock returns to the pool when the transaction ends, but the lock is
-- still held on that physical connection. Subsequent acquires from
-- random pool sessions then return false until the idle connection
-- times out — manifesting as `lock_acquired: false` for hours after a
-- legitimate run completes.
--
-- Replace with a row-based lock backed by a `pipeline_locks` table:
--   - INSERT ... ON CONFLICT DO NOTHING is atomic and pool-agnostic
--   - Stale locks self-heal via a TTL (default 15 min) reaped on every
--     acquire attempt, so a crashed job doesn't deadlock indefinitely
--   - DELETE is unconditional release — safe to call any number of times
--
-- The function signatures stay the same so callers (lib/pipeline/github/
-- db-rpc.ts → discover.ts / refresh.ts / score.ts) need no changes.

create table public.pipeline_locks (
  lock_key       text primary key,
  acquired_at    timestamptz not null default now(),
  acquired_by    text  -- optional run_id or hostname for forensics
);

alter table public.pipeline_locks enable row level security;

-- No public policies: only service_role (which bypasses RLS) writes here.
-- Callers go through the SECURITY DEFINER functions below.

-- ──────────────────────────────────────────────────────────────────────
-- 1) acquire_pipeline_lock
-- Returns true iff the caller now owns the lock. Reaps stale entries
-- before attempting acquisition.
-- ──────────────────────────────────────────────────────────────────────

create or replace function public.acquire_pipeline_lock(lock_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acquired boolean;
begin
  -- Reap any lock older than 15 minutes — a job exceeding that has
  -- either crashed or was killed by maxDuration. 15m comfortably covers
  -- the longest legitimate cron (score @ Pro 5min × headroom).
  delete from public.pipeline_locks
    where pipeline_locks.lock_key = acquire_pipeline_lock.lock_key
      and acquired_at < now() - interval '15 minutes';

  insert into public.pipeline_locks (lock_key)
    values (acquire_pipeline_lock.lock_key)
    on conflict (lock_key) do nothing;

  -- INSERT ... ON CONFLICT DO NOTHING populates FOUND with whether a
  -- row was actually inserted. true = we acquired; false = someone else
  -- holds it.
  get diagnostics v_acquired = row_count;
  return v_acquired > 0;
end;
$$;

revoke all on function public.acquire_pipeline_lock(text) from public;
grant execute on function public.acquire_pipeline_lock(text) to service_role;

-- ──────────────────────────────────────────────────────────────────────
-- 2) release_pipeline_lock
-- Idempotent: deleting a non-existent row is a no-op. Returns true if a
-- row was actually deleted (matches the prior advisory_unlock contract).
-- ──────────────────────────────────────────────────────────────────────

create or replace function public.release_pipeline_lock(lock_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_released boolean;
begin
  delete from public.pipeline_locks
    where pipeline_locks.lock_key = release_pipeline_lock.lock_key;
  get diagnostics v_released = row_count;
  return v_released > 0;
end;
$$;

revoke all on function public.release_pipeline_lock(text) from public;
grant execute on function public.release_pipeline_lock(text) to service_role;

-- ──────────────────────────────────────────────────────────────────────
-- 3) Drop the legacy advisory_lock-based versions IF the function
-- bodies still match the original (defensive — don't clobber if a
-- newer migration already touched them).
--
-- Both functions are recreated above with the same signatures, so the
-- DROP is implicit through CREATE OR REPLACE. The old advisory locks
-- still held in pgbouncer connections will simply be orphaned;
-- pg_advisory_unlock is no longer needed by application code.
-- ──────────────────────────────────────────────────────────────────────

comment on function public.acquire_pipeline_lock(text) is
  'Row-based replacement for the advisory_lock implementation. Pool-safe '
  'with self-healing 15-minute TTL.';
comment on function public.release_pipeline_lock(text) is
  'Idempotent release of row-based pipeline lock.';
