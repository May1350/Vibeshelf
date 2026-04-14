-- ══════════════════════════════════════════════════════════════════════
-- Migration: pipeline advisory-lock helpers + github_tokens acquisition RPC
--
-- Three SECURITY DEFINER functions, all service_role only:
--
-- 1) acquire_pipeline_lock(lock_key)   → boolean
-- 2) release_pipeline_lock(lock_key)   → boolean
-- 3) acquire_github_token(scope)       → table(...)
--
-- Why advisory locks (#1, #2):
--   Vercel cron can double-fire during deploy-overlap windows, and
--   manual triggers can race with scheduled runs. Postgres advisory
--   locks give us fail-fast mutual exclusion without a dedicated
--   `locks` table. hashtext() converts arbitrary string keys to the
--   int4 expected by pg_try_advisory_lock.
--
-- Why a SECURITY DEFINER RPC for token pick (#3):
--   supabase-js's query builder cannot emit `FOR UPDATE SKIP LOCKED`,
--   but that clause is the whole point — it prevents two concurrent
--   jobs from grabbing the same token and double-spending its rate-
--   limit budget. Decryption of token_encrypted MUST happen in TS
--   (lib/crypto/tokens.ts) because the AES-256-GCM key lives in
--   TOKEN_ENCRYPTION_KEY_V1, not in the DB. So the RPC returns the
--   encrypted row and the caller decrypts.
-- ══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1) acquire_pipeline_lock
-- Returns true if the lock was newly acquired for THIS session, false
-- if another session already holds it. Caller MUST check the return
-- value and fail-fast when false (the typical cron-double-fire case).
-- Locks are released automatically at session end; explicit release via
-- release_pipeline_lock is a courtesy for long-lived connections.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.acquire_pipeline_lock(lock_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return pg_try_advisory_lock(hashtext(lock_key));
end;
$$;

revoke all on function public.acquire_pipeline_lock(text) from public;
grant execute on function public.acquire_pipeline_lock(text) to service_role;

-- ──────────────────────────────────────────────────────────────────────
-- 2) release_pipeline_lock
-- Returns true if the lock was held by THIS session and is now
-- released, false otherwise. Safe to call even if never acquired.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.release_pipeline_lock(lock_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return pg_advisory_unlock(hashtext(lock_key));
end;
$$;

revoke all on function public.release_pipeline_lock(text) from public;
grant execute on function public.release_pipeline_lock(text) to service_role;

-- ──────────────────────────────────────────────────────────────────────
-- 3) acquire_github_token
-- Picks ONE enabled, non-exhausted token for the requested scope and
-- returns its row. Uses FOR UPDATE SKIP LOCKED so concurrent jobs
-- never pick the same token. Ordering rationale:
--   - remaining DESC NULLS FIRST → fresh tokens (NULL remaining =
--     never used) first, then highest-budget tokens. This prevents
--     the anti-selection bug where a near-dead token (remaining=1,
--     early reset_at) would be preferred over a fresh one.
--   - reset_at NULLS FIRST → tiebreaker within same `remaining`
--     value; unobserved-reset rows rank first.
-- Returns zero rows when the pool is exhausted — caller should then
-- consult waitForNextReset and either sleep or throw
-- RateLimitExhaustedError.
--
-- IMPORTANT: the returned token_encrypted is still encrypted; the
-- caller decrypts using lib/crypto/tokens.decryptToken().
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.acquire_github_token(p_scope text)
returns table (
  id                uuid,
  token_encrypted   bytea,
  token_key_version smallint,
  remaining         int,
  reset_at          timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_scope is null or p_scope not in ('search', 'rest', 'graphql') then
    raise exception 'acquire_github_token: invalid scope %', p_scope
      using errcode = 'invalid_parameter_value';
  end if;

  return query
    select t.id, t.token_encrypted, t.token_key_version, t.remaining, t.reset_at
    from public.github_tokens t
    where t.scope = p_scope
      and t.disabled_at is null
      and (t.remaining is null or t.remaining > 0)
    order by t.remaining desc nulls first, t.reset_at nulls first
    limit 1
    for update skip locked;
end;
$$;

revoke all on function public.acquire_github_token(text) from public;
grant execute on function public.acquire_github_token(text) to service_role;
