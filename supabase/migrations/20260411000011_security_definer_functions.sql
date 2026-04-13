-- ══════════════════════════════════════════════════════════════════════
-- 1) handle_new_user
-- Trigger on auth.users INSERT. Creates the public.user_profiles row
-- from the OAuth provider metadata stored in raw_user_meta_data.
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_github_id       bigint;
  v_github_username text;
  v_avatar_url      text;
  v_display_name    text;
begin
  -- Supabase Auth stores OAuth provider metadata in raw_user_meta_data.
  -- For the GitHub provider, we expect: user_name, provider_id, avatar_url, name.
  v_github_username := new.raw_user_meta_data ->> 'user_name';
  v_github_id       := nullif(new.raw_user_meta_data ->> 'provider_id', '')::bigint;
  v_avatar_url      := new.raw_user_meta_data ->> 'avatar_url';
  v_display_name    := coalesce(new.raw_user_meta_data ->> 'name', v_github_username);

  if v_github_id is null or v_github_username is null then
    raise exception
      'handle_new_user: missing required GitHub identity in raw_user_meta_data for auth.users.id %',
      new.id;
  end if;

  insert into public.user_profiles (
    id, github_id, github_username, display_name, avatar_url
  ) values (
    new.id, v_github_id, v_github_username, v_display_name, v_avatar_url
  )
  on conflict (id) do nothing;  -- defensive: trigger fires once per user

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ══════════════════════════════════════════════════════════════════════
-- 2) upsert_user_oauth_token
-- Called by server code during the OAuth callback (authenticated context)
-- to store the encrypted GitHub provider_token. Replaces any prior row
-- for the same user and clears revoked_at.
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.upsert_user_oauth_token(
  p_token_encrypted   bytea,
  p_token_key_version smallint,
  p_scopes            text[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'upsert_user_oauth_token: not authenticated'
      using errcode = '42501';  -- insufficient_privilege
  end if;

  insert into public.github_oauth_tokens (
    user_id, token_encrypted, token_key_version, scopes, last_validated_at, revoked_at
  ) values (
    v_user_id, p_token_encrypted, p_token_key_version, p_scopes, now(), null
  )
  on conflict (user_id) do update
    set token_encrypted   = excluded.token_encrypted,
        token_key_version = excluded.token_key_version,
        scopes            = excluded.scopes,
        last_validated_at = now(),
        revoked_at        = null;
end;
$$;

revoke all on function public.upsert_user_oauth_token(bytea, smallint, text[]) from public;
grant execute on function public.upsert_user_oauth_token(bytea, smallint, text[]) to authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 3) record_fork_event
-- Called by server code after a successful GitHub fork API call.
-- Inserts (or updates) the fork_events row for the calling user.
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.record_fork_event(
  p_repo_id         uuid,
  p_github_fork_id  bigint,
  p_github_fork_url text
)
returns public.fork_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_result  public.fork_events;
begin
  if v_user_id is null then
    raise exception 'record_fork_event: not authenticated'
      using errcode = '42501';
  end if;

  if p_github_fork_id is null or p_github_fork_url is null then
    raise exception 'record_fork_event: fork id and url are required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (
    select 1 from public.repos
    where id = p_repo_id and status = 'published'
  ) then
    raise exception 'record_fork_event: repo % not found or not published', p_repo_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent: same user can re-fork (e.g., retry after deleting the old fork)
  insert into public.fork_events (user_id, repo_id, github_fork_id, github_fork_url)
  values (v_user_id, p_repo_id, p_github_fork_id, p_github_fork_url)
  on conflict (user_id, repo_id) do update
    set github_fork_id  = excluded.github_fork_id,
        github_fork_url = excluded.github_fork_url,
        forked_at       = now()
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.record_fork_event(uuid, bigint, text) from public;
grant execute on function public.record_fork_event(uuid, bigint, text) to authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 4) create_review_with_fork_check
-- THE KEY SECURITY FUNCTION.
-- Enforces: a review insert is allowed only if the calling user has a
-- matching fork_events row (PRD §5.4). Runs as SECURITY DEFINER to
-- write into public.reviews, which has no direct INSERT policy.
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.create_review_with_fork_check(
  p_repo_id         uuid,
  p_rating          smallint,
  p_text_body       text,
  p_vibecoding_tool public.vibecoding_tool
)
returns public.reviews
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_result  public.reviews;
begin
  if v_user_id is null then
    raise exception 'create_review_with_fork_check: not authenticated'
      using errcode = '42501';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'create_review_with_fork_check: rating must be 1..5, got %', p_rating
      using errcode = 'check_violation';
  end if;

  -- ─── KEY CHECK: user must have a fork_events row for this repo ───
  if not exists (
    select 1 from public.fork_events
    where user_id = v_user_id
      and repo_id = p_repo_id
  ) then
    raise exception 'create_review_with_fork_check: user has not forked repo %', p_repo_id
      using errcode = '42501';
  end if;

  -- Repo must currently be published (not dormant / removed)
  if not exists (
    select 1 from public.repos
    where id = p_repo_id and status = 'published'
  ) then
    raise exception 'create_review_with_fork_check: repo % is not published', p_repo_id
      using errcode = 'no_data_found';
  end if;

  insert into public.reviews (repo_id, user_id, rating, text_body, vibecoding_tool)
  values (p_repo_id, v_user_id, p_rating, p_text_body, p_vibecoding_tool)
  returning * into v_result;

  return v_result;
end;
$$;

revoke all
  on function public.create_review_with_fork_check(uuid, smallint, text, public.vibecoding_tool)
  from public;
grant execute
  on function public.create_review_with_fork_check(uuid, smallint, text, public.vibecoding_tool)
  to authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 5) mark_oauth_token_revoked
-- Called by server code (authenticated context) when GitHub responds 401
-- to a fork call, to mark the calling user's token as needing re-auth.
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.mark_oauth_token_revoked()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'mark_oauth_token_revoked: not authenticated'
      using errcode = '42501';
  end if;

  update public.github_oauth_tokens
    set revoked_at = now()
    where user_id = v_user_id
      and revoked_at is null;
end;
$$;

revoke all on function public.mark_oauth_token_revoked() from public;
grant execute on function public.mark_oauth_token_revoked() to authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 6) get_my_oauth_token_encrypted
-- Called by authenticated server code (fork flow) to read the calling
-- user's encrypted GitHub provider_token.
--
-- This is the READ counterpart to upsert_user_oauth_token (#2). Both
-- token paths go through SECURITY DEFINER functions so the web layer
-- never needs a service_role client for user-scoped token operations.
-- Decryption happens in lib/crypto/tokens.ts using TOKEN_ENCRYPTION_KEY_V{n}.
-- Revoked tokens (revoked_at IS NOT NULL) return zero rows — the caller
-- treats an empty result as "user must re-authenticate".
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.get_my_oauth_token_encrypted()
returns table (
  token_encrypted   bytea,
  token_key_version smallint,
  scopes            text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_found   boolean;
begin
  if v_user_id is null then
    raise exception 'get_my_oauth_token_encrypted: not authenticated'
      using errcode = '42501';
  end if;

  -- Must find an active (non-revoked) token. We raise explicitly instead
  -- of returning zero rows to prevent a footgun: a TS caller destructuring
  -- [row] from an empty result would get `undefined` and silently proceed
  -- with broken bytes. P0002 ('no_data_found') is the semantically correct
  -- errcode — callers map it to "prompt re-auth via OAuth callback".
  select exists (
    select 1 from public.github_oauth_tokens
    where user_id = v_user_id
      and revoked_at is null
  ) into v_found;

  if not v_found then
    raise exception 'get_my_oauth_token_encrypted: no active token for user %', v_user_id
      using errcode = 'P0002';  -- no_data_found
  end if;

  return query
    select t.token_encrypted, t.token_key_version, t.scopes
    from public.github_oauth_tokens t
    where t.user_id = v_user_id
      and t.revoked_at is null;
end;
$$;

revoke all on function public.get_my_oauth_token_encrypted() from public;
grant execute on function public.get_my_oauth_token_encrypted() to authenticated;
