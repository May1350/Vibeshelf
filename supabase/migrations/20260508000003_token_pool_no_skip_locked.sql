-- Migration 5c: drop FOR UPDATE SKIP LOCKED from acquire_github_token
--
-- The original implementation locked the picked row to prevent two
-- callers from "selecting the same token". But GitHub rate-limits per
-- PAT, not per call — five concurrent workers all using the same PAT
-- is identical from GitHub's perspective to one worker using it five
-- times. The lock-and-skip pattern only makes sense if you have many
-- tokens and want to spread load across them; with a single token,
-- four of every five concurrent callers would see the row as locked
-- and return null → caller upgrades to PoolExhaustedError → job fails
-- despite plenty of remaining quota.
--
-- Replacement: read the freshest non-exhausted token without locking.
-- Concurrent UPDATEs in releaseToken still serialize correctly via the
-- per-row UPDATE lock, and any momentary disagreement on `remaining`
-- self-corrects on the next response (where we read the authoritative
-- X-RateLimit-Remaining header).

drop function if exists public.acquire_github_token(text);

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
    limit 1;
end;
$$;

revoke all on function public.acquire_github_token(text) from public;
grant execute on function public.acquire_github_token(text) to service_role;
