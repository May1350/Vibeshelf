-- ══════════════════════════════════════════════════════════════════════
-- user_profiles
--   Extends auth.users with GitHub identity and display info.
--   One row per Supabase auth user. Created by Auth trigger on first sign-in
--   (trigger defined in Chunk B).
-- ══════════════════════════════════════════════════════════════════════
create table public.user_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  github_id       bigint unique not null,
  github_username text unique not null,
  display_name    text,
  avatar_url      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_user_profiles_github_username
  on public.user_profiles(github_username);

create trigger trg_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

alter table public.user_profiles enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- github_oauth_tokens
--   Per-user encrypted GitHub access_token for fork API calls.
--   Separated from user_profiles to minimize blast radius (R1/R2 finding).
--   Service role ONLY — no authenticated access. RLS policies in Chunk B
--   produce a deny-all baseline for authenticated users.
-- ══════════════════════════════════════════════════════════════════════
create table public.github_oauth_tokens (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  token_encrypted    bytea not null,
  token_key_version  smallint not null,   -- identifies which AES key version encrypted this
  scopes             text[] not null,     -- e.g., ARRAY['public_repo']
  last_validated_at  timestamptz,
  revoked_at         timestamptz,         -- set when GitHub responds 401 on a fork call
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger trg_github_oauth_tokens_updated_at
  before update on public.github_oauth_tokens
  for each row execute function public.set_updated_at();

alter table public.github_oauth_tokens enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- github_tokens
--   Application-level token POOL for GitHub REST calls during ingestion.
--   Used by pipeline for unauthenticated / app-identity calls.
--   PRD §12 mitigation for GitHub API rate limits (5000/hr per token).
--   Tokens are ephemeral identities (PATs or GitHub App installation tokens),
--   not user OAuth tokens.
-- ══════════════════════════════════════════════════════════════════════
create table public.github_tokens (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null,        -- human name, e.g., 'crawler-01'
  token_encrypted    bytea not null,
  token_key_version  smallint not null,
  remaining          int,                   -- last-seen X-RateLimit-Remaining
  reset_at           timestamptz,           -- last-seen X-RateLimit-Reset
  scope              text not null check (scope in ('search', 'rest', 'graphql')),
  disabled_at        timestamptz,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now()
);

-- Partial index: only enabled tokens, sorted so the pool rotator picks freshest
create index idx_github_tokens_enabled_by_reset
  on public.github_tokens(scope, reset_at nulls first)
  where disabled_at is null;

alter table public.github_tokens enable row level security;
