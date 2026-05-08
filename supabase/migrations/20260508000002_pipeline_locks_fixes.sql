-- Migration 5b: fix two bugs in 20260508000001_pipeline_locks_row_based
--
-- 1. `lock_key` parameter clashed with the column name throughout —
--    rename the function parameter to `p_lock_key` and qualify all
--    column references.
-- 2. `GET DIAGNOSTICS x = row_count` returns int, not boolean — declare
--    the diagnostic variable as int and compare to 0.

drop function if exists public.acquire_pipeline_lock(text);
drop function if exists public.release_pipeline_lock(text);

create or replace function public.acquire_pipeline_lock(p_lock_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  delete from public.pipeline_locks
    where pipeline_locks.lock_key = p_lock_key
      and pipeline_locks.acquired_at < now() - interval '15 minutes';

  insert into public.pipeline_locks (lock_key)
    values (p_lock_key)
    on conflict (lock_key) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.acquire_pipeline_lock(text) from public;
grant execute on function public.acquire_pipeline_lock(text) to service_role;

create or replace function public.release_pipeline_lock(p_lock_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  delete from public.pipeline_locks
    where pipeline_locks.lock_key = p_lock_key;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.release_pipeline_lock(text) from public;
grant execute on function public.release_pipeline_lock(text) to service_role;
