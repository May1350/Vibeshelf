---
title: VibeShelf Foundation — Design Spec
date: 2026-04-11
status: draft (Chunks A + B of 4)
sub_project: 01-foundation
parent_prd: VibeShelf_PRD_Final.md
related_docs:
  - docs/architecture/future-separation-plan.md
  - docs/architecture/open-questions.md
---

# VibeShelf Foundation — Design Spec

**Sub-project #1 of 6.** Sets up the Next.js application scaffold, Supabase project links, database schema, authentication wiring, environment management, CI pipeline, and hosting. Every subsequent sub-project (ingestion, evaluation, marketplace UI, identity+fork+reviews, Pro features) builds on top of Foundation's decisions.

> **Chunked spec.** This document is being written in 4 chunks with user approval between each:
>
> - **Chunk A (done):** Purpose, scope, decision summary, database schema (DDL), migration layout
> - **Chunk B (this section):** RLS policies + `SECURITY DEFINER` functions + review-eligibility enforcement
> - **Chunk C:** Directory structure, `lib/env.ts`, `lib/db/`, `lib/storage/`, dependency-cruiser + ESLint rules
> - **Chunk D:** CI workflow, OAuth app registration, Vercel provisioning, testing strategy, acceptance criteria

---

## 1. Purpose and scope

### 1.1 What Foundation delivers

By the end of Foundation, the repository is:

- A deployable Next.js 16+ App Router application linked to a Vercel project.
- Connected to two Supabase cloud projects: `vibeshelf-dev` and `vibeshelf-prod`.
- Database schema migrated: **12 tables**, RLS enabled on all user-data tables, `SECURITY DEFINER` function enforcing the "only forkers can review" rule.
- Authentication wired for GitHub OAuth via Supabase Auth (sign-in/sign-out flow + `user_profiles` creation on first sign-in).
- CI pipeline that replays migrations against a fresh Supabase stack in Docker on every PR.
- Code boundaries enforced at lint/CI level: `dependency-cruiser` + ESLint rules reject any future PR that imports framework APIs inside `lib/pipeline/` or `lib/types/`.

### 1.2 What Foundation explicitly does NOT deliver

- **No ingestion logic** — no GitHub crawler, no repo discovery job. Empty `repos` table. (sub-project #2)
- **No scoring or classification** — empty `repo_scores` and `repo_tags`. (sub-project #3)
- **No marketplace UI** beyond a skeleton landing page with a sign-in button. (sub-project #4)
- **No fork flow** — the `SECURITY DEFINER` function exists, but no UI or route calls it. (sub-project #5)
- **No review writing UI** — table and policy exist, but no form. (sub-project #5)
- **No Stripe, brand matching, or playbook.** Pro-tier tables are not created. (sub-project #6)
- **No automated demo screenshots** — see `docs/architecture/open-questions.md` Q-01.

### 1.3 Success criteria (Foundation acceptance)

1. `pnpm install && pnpm build` succeeds on a fresh clone after `.env.local` is populated from the dev Supabase project.
2. `supabase db reset --linked` (against `vibeshelf-dev`) applies all migrations cleanly.
3. CI passes on a trivial PR: Docker-based Supabase stack boots, migrations replay from scratch, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` all green.
4. A manual GitHub sign-in through the deployed preview URL succeeds and creates a `user_profiles` row keyed to the signed-in user's `auth.users.id`.
5. `dependency-cruiser` rejects a PR that introduces `import { cookies } from 'next/headers'` inside `lib/pipeline/`, proving the guardrail works.
6. Zero hand-written `process.env.*` access outside `lib/env.ts` — verified by a custom ESLint `no-restricted-syntax` rule.

---

## 2. Decision summary

All 17 decisions baked into this spec, traceable back to brainstorming questions Q1–Q5 and the two-reviewer pass. "R1" = `superpowers:code-reviewer`, "R2" = `codex:codex-rescue`.

| #   | Area                         | Decision                                                                                                                                                                                                    | Source    |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| D1  | Repo structure               | Single Next.js app on one Vercel project. Long jobs use Vercel Workflow DevKit. Monorepo deferred per `docs/architecture/future-separation-plan.md`.                                                        | Q1        |
| D2  | DB scope                     | Free-tier core entities + observability + token pool. **12 tables**, not the original 5. Pro-tier tables remain in sub-project #6.                                                                          | Q2 + R1   |
| D3  | Auth provider                | Supabase Auth with GitHub OAuth provider. RLS as the primary security boundary.                                                                                                                             | Q3        |
| D4  | `provider_token` storage     | **Separate table** `github_oauth_tokens` with AES-encrypted token, key versioning, `revoked_at` column. Service-role only. **Not** inside `user_profiles` (blast radius reduction).                         | Q3 + R1/R2|
| D5  | DB client                    | Raw `@supabase/supabase-js` + `supabase gen types typescript`. SQL migrations via Supabase CLI. **No ORM.** All access encapsulated in `lib/db/`.                                                            | Q4        |
| D6  | Local dev DB                 | Cloud Supabase only (`vibeshelf-dev`). No local Docker for developer machines.                                                                                                                              | Q5        |
| D7  | CI drift check               | GitHub Actions CI runs `supabase start` Docker on every PR to replay migrations from scratch. **No shadow cloud project. No `--linked` drift check.** `supabase/migrations/` is the sole source of truth; no one modifies dev schema via dashboard. | Post-Q5   |
| D8  | Demo screenshot capture      | **Not implemented in MVP.** `asset_kind` enum includes `'demo_screenshot'` as a reserved slot. Implementation deferred to sub-project #2/#3 per `open-questions.md` Q-01.                                   | Post-Q5   |
| D9  | Fork verification            | `fork_events` table + `SECURITY DEFINER` function `create_review_with_fork_check()`. Pure RLS alone is insufficient because fork proof arrives from GitHub side effects.                                    | R1 + R2   |
| D10 | Observability baseline       | `pipeline_runs` table + OTel drain to Vercel Observability. Every `runJob()` invocation creates a `pipeline_runs` row and emits a trace span.                                                                | R1        |
| D11 | Category + tag normalization | `repo_category` PG enum (8 stable values per PRD §4.3). Tags in a lookup table with `citext` slug uniqueness + `repo_tags` junction. AI output is normalized on insert.                                      | R1        |
| D12 | Preview assets               | Separate `repo_assets` and `review_assets` tables (not a single URL column on `repos`). `repo_assets.kind` enum matches PRD §5.1 priority tiers.                                                             | R1        |
| D13 | Scoring history              | `repo_scores` is **append-only** with an `is_latest` flag for current row. Full history enables the AI-vs-user-rating drift analysis promised in PRD §4.2.                                                   | R1        |
| D14 | Repo lifecycle               | `repo_status` enum: `pending → scored → published → dormant → removed`.                                                                                                                                      | R1        |
| D15 | Toolchain defaults           | pnpm, Next.js 16+ App Router + Turbopack, TypeScript, Biome linter, Vitest + Playwright, Tailwind + shadcn/ui, Vercel hosting. **Next.js Cache Components deferred post-MVP.**                               | Post-Q5   |
| D16 | GitHub OAuth apps            | **Two separate apps** (dev, prod), `public_repo` scope only. Distinct callback URLs. Token values are not portable between envs.                                                                              | R1        |
| D17 | Pipeline fan-out pattern     | WDK parent workflow spawns N child workflows (~50 repos each) with a concurrency cap + `github_tokens` pool rotation. This is the documented day-1 pattern, not a retrofit.                                 | R1 + R2   |

---

## 3. Database schema

### 3.1 Migration file layout

Migration files live under `supabase/migrations/` with Supabase's timestamp-prefix convention. Foundation ships the following files:

```
supabase/migrations/
├── 20260411000001_extensions_and_enums.sql
├── 20260411000002_user_and_auth_tables.sql
├── 20260411000003_repo_tables.sql
├── 20260411000004_social_tables.sql
├── 20260411000005_observability_tables.sql
├── 20260411000010_rls_policies.sql              ← Chunk B
└── 20260411000011_security_definer_functions.sql ← Chunk B
```

Chunk A defines files `000001` through `000005` (schema). Chunk B defines files `000010` and `000011` (security layer). Supabase applies them in lexicographic order regardless of the file split — the gap (`00000x` vs `0001x`) is purely for readability of this document.

### 3.2 Schema conventions

- All tables live in the `public` schema unless noted.
- Primary keys: `uuid` with `gen_random_uuid()` default, except `user_profiles.id` which mirrors `auth.users.id`.
- Timestamps: `timestamptz` with `default now()`.
- `updated_at` is maintained by the shared trigger function `public.set_updated_at()`.
- Foreign keys use `on delete cascade` unless noted. `repo_tags.tag_id` is `on delete restrict` because tags should be deleted explicitly, not swept along.
- Indexes on foreign key columns + hot filter paths (status, category, stars, last_commit_at).
- No direct modification of the `auth.users` schema — we extend via `user_profiles` in the `public` schema.

### 3.3 File `000001`: extensions and enums

```sql
-- ══════════════════════════════════════════════════════════════════════
-- Extensions
--   pgcrypto: gen_random_uuid(), symmetric encryption helpers
--   citext:   case-insensitive text for tag slugs (normalized matching)
-- ══════════════════════════════════════════════════════════════════════
create extension if not exists pgcrypto;
create extension if not exists citext;

-- ══════════════════════════════════════════════════════════════════════
-- Enums
-- ══════════════════════════════════════════════════════════════════════

-- Repo category: stable 8 values (PRD §4.3)
create type public.repo_category as enum (
  'saas',
  'ecommerce',
  'dashboard',
  'landing_page',
  'ai_tool',
  'utility',
  'game',
  'other'
);

-- Repo lifecycle (used by ingestion + marketplace visibility)
create type public.repo_status as enum (
  'pending',    -- newly discovered, not yet scored
  'scored',     -- scored but held back (e.g., awaiting manual review)
  'published',  -- visible in marketplace
  'dormant',    -- no recent commits, demoted from default sorts
  'removed'     -- delisted (license change, takedown, manual removal)
);

-- Preview asset kind (PRD §5.1 priority tiers)
-- 'demo_screenshot' is reserved; MVP does not populate it.
-- See docs/architecture/open-questions.md Q-01.
create type public.asset_kind as enum (
  'readme_gif',       -- tier 1
  'readme_image',     -- tier 2
  'demo_screenshot',  -- tier 3 (reserved for post-MVP)
  'ai_generated'      -- tier 4 (text placeholder from Gemini)
);

-- Tag namespace (tags lookup table uses this)
create type public.tag_kind as enum (
  'tech_stack',       -- nextjs, react, python, supabase, stripe, ...
  'vibecoding_tool',  -- cursor, bolt, lovable, replit
  'feature'           -- auth, payments, dark_mode, ai_integration, responsive, ...
);

-- Which vibecoding tool a reviewer used (PRD §5.4)
create type public.vibecoding_tool as enum (
  'cursor',
  'bolt',
  'lovable',
  'replit',
  'other'
);

-- Pipeline run lifecycle (observability)
create type public.pipeline_run_status as enum (
  'running',
  'success',
  'failed',
  'cancelled'
);

-- ══════════════════════════════════════════════════════════════════════
-- Shared trigger helper
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
```

### 3.4 File `000002`: user and auth tables

```sql
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
```

### 3.5 File `000003`: repo tables

```sql
-- ══════════════════════════════════════════════════════════════════════
-- repos
--   Core repo metadata table. Populated by ingestion pipeline (sub-project #2).
-- ══════════════════════════════════════════════════════════════════════
create table public.repos (
  id                      uuid primary key default gen_random_uuid(),
  github_id               bigint unique not null,          -- GitHub's numeric repo id
  owner                   text not null,
  name                    text not null,
  full_name               text generated always as (owner || '/' || name) stored,
  description             text,
  homepage                text,                             -- demo URL if set on GitHub
  license                 text not null,                    -- permissive allowlist enforced by ingestion code, not DB
  default_branch          text not null default 'main',
  stars                   int not null default 0,
  forks                   int not null default 0,
  watchers                int not null default 0,
  last_commit_at          timestamptz not null,
  github_created_at       timestamptz not null,
  github_pushed_at        timestamptz not null,
  readme_sha              text,                             -- content hash for change detection
  category                public.repo_category,             -- null until scored
  status                  public.repo_status not null default 'pending',
  supports_brand_matching boolean not null default false,   -- CSS-variable detection (PRD §6.1 Pro prereq)
  capabilities            jsonb not null default '{}'::jsonb,  -- reserved for future capability flags
  metadata                jsonb not null default '{}'::jsonb,  -- raw GitHub API extras
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (owner, name)
);

-- Hot paths for marketplace queries (published repos only)
create index idx_repos_published_category
  on public.repos(status, category)
  where status = 'published';

create index idx_repos_published_stars
  on public.repos(stars desc)
  where status = 'published';

create index idx_repos_published_recent
  on public.repos(last_commit_at desc)
  where status = 'published';

create trigger trg_repos_updated_at
  before update on public.repos
  for each row execute function public.set_updated_at();

alter table public.repos enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- repo_scores
--   APPEND-ONLY score history. is_latest flag identifies the current row.
--   History enables the AI-vs-user-rating drift analysis (PRD §4.2).
--   Each row records the exact scoring model and prompt version for
--   reproducibility of the feedback loop.
-- ══════════════════════════════════════════════════════════════════════
create table public.repo_scores (
  id                       uuid primary key default gen_random_uuid(),
  repo_id                  uuid not null references public.repos(id) on delete cascade,
  documentation_score      numeric(3,2) not null check (documentation_score between 0 and 5),
  maintenance_score        numeric(3,2) not null check (maintenance_score between 0 and 5),
  popularity_score         numeric(3,2) not null check (popularity_score between 0 and 5),
  code_health_score        numeric(3,2) not null check (code_health_score between 0 and 5),
  vibecoding_compat_score  numeric(3,2) not null check (vibecoding_compat_score between 0 and 5),
  total_score              numeric(3,2) not null check (total_score between 0 and 5),
  scoring_model            text not null,                 -- e.g., 'gemini-flash-lite-1.5'
  scoring_prompt_version   text not null,                 -- e.g., 'v3'
  raw_response             jsonb,                          -- full AI response for re-analysis
  scored_at                timestamptz not null default now(),
  is_latest                boolean not null default true
);

-- At most one is_latest=true per repo (partial unique index)
create unique index idx_repo_scores_one_latest_per_repo
  on public.repo_scores(repo_id)
  where is_latest = true;

create index idx_repo_scores_history
  on public.repo_scores(repo_id, scored_at desc);

alter table public.repo_scores enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- tags
--   Normalized lookup. citext slug prevents duplicate-by-case.
--   Insert-or-match against tags.slug is done by the AI-output normalizer
--   in the ingestion pipeline.
-- ══════════════════════════════════════════════════════════════════════
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  slug       citext unique not null,      -- case-insensitive uniqueness
  kind       public.tag_kind not null,
  label      text not null,               -- display form, e.g., 'Next.js'
  created_at timestamptz not null default now()
);

create index idx_tags_kind on public.tags(kind);

alter table public.tags enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- repo_tags (junction)
-- ══════════════════════════════════════════════════════════════════════
create table public.repo_tags (
  repo_id    uuid not null references public.repos(id) on delete cascade,
  tag_id     uuid not null references public.tags(id) on delete restrict,
  confidence numeric(3,2) check (confidence between 0 and 1),  -- AI confidence in this tag
  source     text not null check (source in ('ai', 'manual', 'review_derived')),
  created_at timestamptz not null default now(),
  primary key (repo_id, tag_id)
);

create index idx_repo_tags_by_tag on public.repo_tags(tag_id, repo_id);

alter table public.repo_tags enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- repo_assets
--   Preview media for each repo (PRD §5.1 priority tiers).
--   A single repo can have multiple assets with different kinds.
--   priority column controls UI ordering (lower number = shown first).
-- ══════════════════════════════════════════════════════════════════════
create table public.repo_assets (
  id             uuid primary key default gen_random_uuid(),
  repo_id        uuid not null references public.repos(id) on delete cascade,
  kind           public.asset_kind not null,
  storage_key    text,               -- Supabase Storage key (null if external)
  external_url   text,               -- direct URL (e.g., README-embedded github user-content)
  width          int,
  height         int,
  content_type   text,                -- e.g., 'image/gif', 'image/webp'
  priority       int not null default 100,
  source_url     text,                -- origin URL where this asset was found
  ai_description text,                -- populated only for kind='ai_generated'
  created_at     timestamptz not null default now(),
  -- Constraint: which columns must be populated depends on the asset kind.
  --   'ai_generated' → must have ai_description (storage_key/external_url may be null)
  --   all others     → must have either storage_key or external_url
  check (
    case kind
      when 'ai_generated' then ai_description is not null
      else (storage_key is not null or external_url is not null)
    end
  )
);

create index idx_repo_assets_repo_priority
  on public.repo_assets(repo_id, priority);

alter table public.repo_assets enable row level security;
```

### 3.6 File `000004`: social tables

```sql
-- ══════════════════════════════════════════════════════════════════════
-- fork_events
--   Proof that a user forked a specific repo. Review-write eligibility
--   depends on the existence of a matching row here (PRD §5.4).
--
--   Rows are inserted ONLY by the SECURITY DEFINER function fork_repo()
--   defined in Chunk B. Direct INSERT by authenticated users is blocked
--   by RLS. This prevents a malicious client from inserting a fake fork
--   row to unlock review writing.
-- ══════════════════════════════════════════════════════════════════════
create table public.fork_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  repo_id         uuid not null references public.repos(id) on delete cascade,
  github_fork_id  bigint not null,     -- GitHub numeric id of the forked repo
  github_fork_url text not null,
  forked_at       timestamptz not null default now(),
  unique (user_id, repo_id)
);

create index idx_fork_events_user on public.fork_events(user_id);
create index idx_fork_events_repo on public.fork_events(repo_id);

alter table public.fork_events enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- reviews
--   User review of a repo. One review per (user, repo).
--
--   Rows are inserted ONLY by the SECURITY DEFINER function
--   create_review_with_fork_check() defined in Chunk B, which verifies
--   that a matching fork_events row exists before inserting.
--
--   Update/delete of own row are allowed via RLS.
-- ══════════════════════════════════════════════════════════════════════
create table public.reviews (
  id              uuid primary key default gen_random_uuid(),
  repo_id         uuid not null references public.repos(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  rating          smallint not null check (rating between 1 and 5),
  text_body       text,
  vibecoding_tool public.vibecoding_tool,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (repo_id, user_id)
);

create index idx_reviews_repo on public.reviews(repo_id, created_at desc);
create index idx_reviews_user on public.reviews(user_id);

create trigger trg_reviews_updated_at
  before update on public.reviews
  for each row execute function public.set_updated_at();

alter table public.reviews enable row level security;

-- ══════════════════════════════════════════════════════════════════════
-- review_assets
--   Up to 5 images per review (PRD §5.4). Always hosted in Supabase
--   Storage (never external URL) because we want to guarantee the
--   image is still visible if the user deletes it from elsewhere.
--
--   5-per-review limit is enforced by a BEFORE INSERT trigger.
-- ══════════════════════════════════════════════════════════════════════
create table public.review_assets (
  id           uuid primary key default gen_random_uuid(),
  review_id    uuid not null references public.reviews(id) on delete cascade,
  storage_key  text not null,
  content_type text not null,
  width        int,
  height       int,
  ordering     smallint not null check (ordering between 0 and 4),
  created_at   timestamptz not null default now(),
  unique (review_id, ordering)
);

create index idx_review_assets_review on public.review_assets(review_id);

alter table public.review_assets enable row level security;

-- Hard limit: at most 5 assets per review
create or replace function public.enforce_review_asset_limit()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.review_assets where review_id = new.review_id) >= 5 then
    raise exception 'review_assets: limit of 5 exceeded for review_id %', new.review_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_review_assets_limit
  before insert on public.review_assets
  for each row execute function public.enforce_review_asset_limit();
```

### 3.7 File `000005`: observability tables

```sql
-- ══════════════════════════════════════════════════════════════════════
-- pipeline_runs
--   Observability record for every scheduled/cron/WDK job invocation.
--   Every runJob() wrapper inserts a row on start and updates it on
--   completion. See Chunk C for the wrapper code.
--
--   parent_run_id enables WDK fan-out hierarchy: a parent "score-all-repos"
--   run spawns child "score-batch" runs, each linking back via parent_run_id.
-- ══════════════════════════════════════════════════════════════════════
create table public.pipeline_runs (
  id             uuid primary key default gen_random_uuid(),
  job_name       text not null,                 -- e.g., 'ingest-discover', 'score-batch'
  trace_id       text,                           -- OTel trace id for cross-system correlation
  parent_run_id  uuid references public.pipeline_runs(id) on delete set null,
  input          jsonb,
  status         public.pipeline_run_status not null default 'running',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  error_message  text,
  error_stack    text,
  metrics        jsonb                            -- e.g., {repos_scanned: 50, tokens_used: 120}
);

create index idx_pipeline_runs_job_time
  on public.pipeline_runs(job_name, started_at desc);

create index idx_pipeline_runs_active_or_failed
  on public.pipeline_runs(status, started_at desc)
  where status in ('running', 'failed');

create index idx_pipeline_runs_parent
  on public.pipeline_runs(parent_run_id)
  where parent_run_id is not null;

alter table public.pipeline_runs enable row level security;
```

---

## 4. Chunk A self-review (resolved)

After writing Chunk A, I re-read it and resolved the open items below. One schema fix was applied inline to §3.5.

### 4.1 Applied fix — `repo_assets` CHECK constraint hole

**Problem:** The original constraint allowed `kind = 'ai_generated'` rows without requiring `ai_description`, meaning an AI-generated placeholder could have all three content columns NULL — a row that claims to be an AI description but has nothing to show.

**Fix:** Replaced the constraint with a CASE expression that requires `ai_description IS NOT NULL` when `kind = 'ai_generated'`, and otherwise requires `storage_key IS NOT NULL OR external_url IS NOT NULL`. Applied inline to §3.5.

### 4.2 `repos.license` as free text (not enum) — **approved**

New permissive licenses appear occasionally (BlueOak, 0BSD, ISC, MIT-0, Unlicense). The ingestion pipeline (sub-project #2) maintains a TypeScript allowlist and rejects anything outside it pre-insert. Enum migration churn avoided.

### 4.3 `repo_assets.external_url` for README-embedded GitHub URLs — **approved for MVP**

README-embedded `user-content.githubusercontent.com` URLs are stored directly (no Storage copy). Egress cost savings outweigh the small risk of GitHub URL format changes. If the risk materializes, a background re-download job can be added post-MVP with no schema change.

### 4.4 `repo_scores.raw_response jsonb` storage cost — **approved**

~120MB over 12 months for 2,000 repos comfortably fits both the Supabase free tier (500MB) and Pro tier (8GB). No compression or truncation policy needed for MVP.

### 4.5 Intentional table absences — **no additions**

`brand_profiles`, `subscriptions`, `playbooks`, and `pipeline_cache_invalidations` remain out of Foundation. All are tracked in `docs/architecture/open-questions.md` or deferred to sub-project #6.

### 4.6 Decision tracing — **verified consistent**

All 17 rows in §2 match the body content. No drift between the decision table and the DDL.

### 4.7 Non-blocking observations

Noted for awareness; none require immediate action:

1. **Repo deletion convention.** `reviews.repo_id` and `fork_events.repo_id` both have `ON DELETE CASCADE`. A hard `DELETE FROM repos` would silently destroy all associated reviews and fork history (data we need for drift analysis). **Mitigation:** operational convention — never `DELETE FROM repos`, always `UPDATE repos SET status = 'removed'`. Chunk C's `lib/db/repos.ts` module will document this and expose no delete method.
2. **`github_tokens.label` not unique.** Labels like `'crawler-01'` could collide if operators add tokens carelessly. Not enforced at the DB level; handled by naming convention.
3. **`tags.updated_at` missing.** Tag labels may occasionally be edited ("Next.js" → "NextJS"). Not a blocker — tag edits are rare and can be audited externally if needed.
4. **Append-only insert pattern for `repo_scores`.** The partial unique index on `(repo_id) WHERE is_latest = true` is the DB safety net. Pipeline code must wrap score upserts in a transaction that flips the old row to `is_latest = false` before inserting the new row; otherwise the insert fails the unique constraint.

---

## 5. Row-level security policies

### 5.1 Security model overview

Three access tiers, enforced by Postgres roles and RLS policies:

| Role            | Who                                                                  | Default on `public` tables |
| --------------- | -------------------------------------------------------------------- | -------------------------- |
| `anon`          | Unauthenticated visitors (public browse)                              | Access gated by policy     |
| `authenticated` | Signed-in users                                                       | Access gated by policy     |
| `service_role`  | Server-side code using the Supabase service role key                  | **Bypasses RLS**           |

**Deny-by-default pattern for sensitive tables.** Three tables store secrets or internal observability data that `anon` and `authenticated` must never touch:

- `github_oauth_tokens` — per-user encrypted GitHub access tokens
- `github_tokens` — application-level GitHub token pool
- `pipeline_runs` — pipeline execution observability log

For these tables, RLS is **enabled** but **no policies are written**. In Postgres, enabled RLS with no matching policy means the role is denied. `service_role` continues to work because it bypasses RLS by default. Authenticated context writes to these tables only through `SECURITY DEFINER` functions (§6).

**Why not explicit `using (false)` deny policies?** They add noise without improving security. The idiomatic Supabase pattern is "enable RLS, no policies = denied".

**Column-level GRANT layered under RLS.** For `user_profiles`, users are allowed to UPDATE their own row, but only the `display_name` and `avatar_url` columns. This is expressed as a column-level `GRANT` (RLS cannot restrict columns). `github_id` and `github_username` are set by the `handle_new_user` trigger and updated by service role on re-auth.

**Fork-gated reviews (the key security invariant).** The PRD requires "only forkers can review". Pure RLS cannot enforce this because the proof of forking comes from a GitHub side effect, not a client-held row. Instead:

1. `fork_events` has `SELECT` policy (own rows only) and **no direct INSERT/UPDATE/DELETE** policies for `authenticated`.
2. `record_fork_event()` `SECURITY DEFINER` function is the sole entry point for inserting fork events. It runs after server code has confirmed a successful GitHub fork API call.
3. `reviews` has UPDATE/DELETE policies on own rows but **no INSERT policy**.
4. `create_review_with_fork_check()` `SECURITY DEFINER` function is the sole entry point for creating reviews. It verifies that a matching `fork_events` row exists before inserting.

A malicious client cannot bypass this — both tables reject direct INSERT via RLS, and the `SECURITY DEFINER` functions run the fork-check atomically before insert.

### 5.2 File `000010_rls_policies.sql`

```sql
-- ══════════════════════════════════════════════════════════════════════
-- Row-level security policies for every user-facing table.
-- Tables that should be service-role only (github_oauth_tokens,
-- github_tokens, pipeline_runs) have RLS enabled but NO policies here —
-- that's the deny-by-default baseline for anon/authenticated.
-- ══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- user_profiles
-- ──────────────────────────────────────────────────────────────────────
-- Public profiles: anyone can SELECT.
create policy user_profiles_select_all
  on public.user_profiles
  for select
  to anon, authenticated
  using (true);

-- Users can UPDATE their own row. Column-level grant below restricts
-- WHICH columns they can actually change.
create policy user_profiles_update_own
  on public.user_profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Column-level: only display_name and avatar_url are user-mutable.
-- github_id and github_username are managed by handle_new_user / service role.
revoke update on public.user_profiles from authenticated;
grant update (display_name, avatar_url) on public.user_profiles to authenticated;

-- No INSERT policy: user_profiles rows are created by the handle_new_user
-- trigger (in 000011) which runs as SECURITY DEFINER on auth.users INSERT.
-- No DELETE policy: deletion cascades from auth.users deletion.

-- ──────────────────────────────────────────────────────────────────────
-- github_oauth_tokens — SERVICE ROLE ONLY (no policies — deny all)
-- ──────────────────────────────────────────────────────────────────────
-- Intentionally empty. RLS enabled + no policies = denied for
-- anon/authenticated. Authenticated users interact via the
-- upsert_user_oauth_token() SECURITY DEFINER function only.

-- ──────────────────────────────────────────────────────────────────────
-- github_tokens — SERVICE ROLE ONLY (no policies — deny all)
-- ──────────────────────────────────────────────────────────────────────
-- Intentionally empty. Token pool is managed exclusively by pipeline
-- code running under service role.

-- ──────────────────────────────────────────────────────────────────────
-- repos
-- ──────────────────────────────────────────────────────────────────────
create policy repos_select_published
  on public.repos
  for select
  to anon, authenticated
  using (status = 'published');

-- Writes: service role only (no policies for authenticated).

-- ──────────────────────────────────────────────────────────────────────
-- repo_scores
-- ──────────────────────────────────────────────────────────────────────
-- Public reads only the LATEST score for PUBLISHED repos.
-- History rows and scores for non-published repos stay hidden.
create policy repo_scores_select_latest_published
  on public.repo_scores
  for select
  to anon, authenticated
  using (
    is_latest = true
    and exists (
      select 1 from public.repos r
      where r.id = repo_scores.repo_id
        and r.status = 'published'
    )
  );

-- Writes: service role only.

-- ──────────────────────────────────────────────────────────────────────
-- tags — public lookup
-- ──────────────────────────────────────────────────────────────────────
create policy tags_select_all
  on public.tags
  for select
  to anon, authenticated
  using (true);

-- Writes: service role only.

-- ──────────────────────────────────────────────────────────────────────
-- repo_tags
-- ──────────────────────────────────────────────────────────────────────
create policy repo_tags_select_published
  on public.repo_tags
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.repos r
      where r.id = repo_tags.repo_id
        and r.status = 'published'
    )
  );

-- Writes: service role only.

-- ──────────────────────────────────────────────────────────────────────
-- repo_assets
-- ──────────────────────────────────────────────────────────────────────
create policy repo_assets_select_published
  on public.repo_assets
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.repos r
      where r.id = repo_assets.repo_id
        and r.status = 'published'
    )
  );

-- Writes: service role only.

-- ──────────────────────────────────────────────────────────────────────
-- fork_events
-- ──────────────────────────────────────────────────────────────────────
-- Users can see their OWN fork events (for "already forked" badges).
create policy fork_events_select_own
  on public.fork_events
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies.
-- Rows are created ONLY by record_fork_event() SECURITY DEFINER.

-- ──────────────────────────────────────────────────────────────────────
-- reviews
-- ──────────────────────────────────────────────────────────────────────
-- Public can read reviews of published repos.
create policy reviews_select_published
  on public.reviews
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.repos r
      where r.id = reviews.repo_id
        and r.status = 'published'
    )
  );

-- Users can UPDATE their own review (edit rating or text).
create policy reviews_update_own
  on public.reviews
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can DELETE their own review.
create policy reviews_delete_own
  on public.reviews
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- No INSERT policy.
-- Rows are created ONLY by create_review_with_fork_check() SECURITY DEFINER.

-- ──────────────────────────────────────────────────────────────────────
-- review_assets
-- ──────────────────────────────────────────────────────────────────────
-- Public can read assets attached to reviews on published repos.
create policy review_assets_select_public
  on public.review_assets
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.reviews rv
      join public.repos r on r.id = rv.repo_id
      where rv.id = review_assets.review_id
        and r.status = 'published'
    )
  );

-- Users can add assets to their own reviews.
create policy review_assets_insert_own
  on public.review_assets
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.reviews rv
      where rv.id = review_assets.review_id
        and rv.user_id = auth.uid()
    )
  );

-- Users can delete assets from their own reviews.
create policy review_assets_delete_own
  on public.review_assets
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.reviews rv
      where rv.id = review_assets.review_id
        and rv.user_id = auth.uid()
    )
  );

-- No UPDATE policy: assets are immutable — delete and re-insert to replace.

-- ──────────────────────────────────────────────────────────────────────
-- pipeline_runs — SERVICE ROLE ONLY (no policies — deny all)
-- ──────────────────────────────────────────────────────────────────────
-- Observability log. Admin dashboards read this through service role
-- behind an admin-only route; direct authenticated access is denied.
```

---

## 6. SECURITY DEFINER functions and Auth trigger

### 6.1 Overview

Five security-sensitive functions and one Auth trigger live in this migration:

| # | Function                              | Called from                                             | Purpose                                                                       |
| - | ------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 | `handle_new_user()`                   | Auth trigger on `auth.users` INSERT                      | Creates `user_profiles` row from OAuth metadata on first sign-in              |
| 2 | `upsert_user_oauth_token()`           | Authenticated server code (OAuth callback)              | Stores encrypted GitHub `provider_token` for later fork API calls             |
| 3 | `record_fork_event()`                 | Authenticated server code (after GitHub fork API success) | Records a fork; entry point for review eligibility                            |
| 4 | `create_review_with_fork_check()`     | Authenticated server code (review submit)              | **Key security function.** Verifies fork exists, then inserts review          |
| 5 | `mark_oauth_token_revoked()`          | Authenticated server code (after GitHub 401 response)  | Marks caller's OAuth token as revoked so the UI can prompt re-auth            |

Each function is declared:

- `SECURITY DEFINER` — runs with the privileges of the function owner (postgres role / service role), bypassing the deny-by-default RLS on target tables.
- `SET search_path = public, pg_temp` — mitigates search_path injection attacks.
- `REVOKE ALL ... FROM public; GRANT EXECUTE ... TO authenticated` — restricts callers to the `authenticated` role only (no `anon` access).

### 6.2 File `000011_security_definer_functions.sql`

```sql
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
```

---

## 7. Chunk B open items requiring approval

Before moving to Chunk C, please confirm the following security decisions.

### 7.1 Service-role-only tables use "deny by default" pattern

`github_oauth_tokens`, `github_tokens`, and `pipeline_runs` have RLS enabled but no policies. Postgres' enabled-RLS-with-no-policy behavior denies all non-bypass roles.

**Acceptable, or do you want explicit `using (false)` deny policies?** My recommendation: current pattern is idiomatic Supabase. Explicit deny policies add noise without improving security.

### 7.2 Column-level GRANT on `user_profiles` (instead of BEFORE UPDATE trigger)

Users can UPDATE their own row via RLS, but only the `display_name` and `avatar_url` columns (enforced by `GRANT UPDATE (display_name, avatar_url) ... TO authenticated`). `github_id` and `github_username` are set only by `handle_new_user` and by service role on re-auth.

**Acceptable?** Alternative: a BEFORE UPDATE trigger that rejects changes to immutable columns. Triggers fire per row with overhead; column-level GRANTs are checked once at parse time with no per-row cost.

### 7.3 `handle_new_user` trigger parses `raw_user_meta_data` strictly

The trigger reads GitHub identity from Supabase Auth's `raw_user_meta_data` JSON. Expected fields: `user_name`, `provider_id`, `avatar_url`, `name`. If `user_name` or `provider_id` is missing, the trigger raises an exception and the sign-in fails loudly.

**Mitigation:** CI integration test in Chunk D exercises the full GitHub sign-in flow against a local Supabase Auth instance on every PR — if GitHub changes metadata shape, CI catches it before merge.

**Acceptable, or do you want a lenient fallback (e.g., insert a partial profile on missing metadata)?** My recommendation: strict parsing is safer than silently creating broken profiles.

### 7.4 `record_fork_event` trusts its caller

The function does not itself verify the fork exists on GitHub — it trusts that our server code (which called the GitHub fork API first) passes correct `github_fork_id` and `github_fork_url`. A malicious external client cannot call this function directly (authenticated context + the server-side OAuth flow is the only path), so the trust boundary is "our server code is trustworthy".

**Alternative rejected:** the function itself calls GitHub's API. Rejected because (a) makes the function slow and flaky, (b) couples the DB transaction to an external service, (c) pressures GitHub rate limits on a high-traffic path.

**Current approach acceptable?**

### 7.5 Un-forking is not detected (MVP gap)

Users cannot delete their own `fork_events` rows. If a user un-forks on GitHub, we don't notice — their ability to write reviews on that repo remains. This means a bad actor can fork → write glowing review → un-fork, and the review stays.

**Options:**

1. **Accept for MVP** — unforking is rare; review integrity is best-effort at launch.
2. **Post-MVP background job** — periodic check against GitHub API sets an `is_active` flag on `fork_events`. Requires only one new column.
3. **Live check on review submit** — the review function calls GitHub API before insert. Rejected: adds latency and flakiness on the review-submit hot path.

**My recommendation: option 1 for MVP.** Option 2 can be added post-launch with a single column addition and a scheduled job — no schema break.

---

## End of Chunk B

**Approval request:** Does Chunk B look right?

If **yes**, I proceed to Chunk C (directory structure: `lib/env.ts` with zod + scope tags, `lib/db/` Supabase client factory, `lib/storage/`, `dependency-cruiser` config, and the custom ESLint rule banning `process.env` access outside `lib/env.ts`).

If **no**, specify what to revise. Common revision vectors: tighten a policy, add a missing function, split a function, change trust boundaries.
