---
title: VibeShelf Foundation — Design Spec
date: 2026-04-11
status: draft (all 4 chunks — pending self-review + user approval)
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
> - **Chunk B (done):** RLS policies + `SECURITY DEFINER` functions + review-eligibility enforcement
> - **Chunk C (done):** Directory structure, `lib/env.ts`, `lib/db/`, `lib/storage/`, dependency-cruiser + ESLint rules
> - **Chunk D (this section):** CI workflow, OAuth app registration, Vercel provisioning, testing strategy, acceptance criteria

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
├── 20260411000010_rls_policies.sql                   ← Chunk B
├── 20260411000011_security_definer_functions.sql    ← Chunk B
└── 20260411000012_storage_buckets_and_policies.sql  ← Chunk B
```

Chunk A defines files `000001` through `000005` (schema). Chunk B defines files `000010`, `000011`, and `000012` (security and storage layer). Supabase applies them in lexicographic order regardless of the file split — the numeric gap (`00000x` vs `0001x`) is purely for readability of this document.

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
-- NOTE: we deliberately do NOT reserve an `unforked_detected_at` column here.
-- Un-forking detection (see Chunk B §7.5 option 2) needs multi-field state
-- (last check, consecutive misses, detection source) and a real migration
-- with its own index. A single nullable timestamp is the wrong shape —
-- reserving it would lock in a column no one validated.

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

For these tables, RLS is **enabled** but **no policies are written**. In Postgres, enabled RLS with no matching policy means the role is denied. `service_role` continues to work because it bypasses RLS by default. Authenticated context both reads from **and** writes to these tables only through `SECURITY DEFINER` functions (§6) — symmetrically. The web layer never instantiates a `service_role` client **for user-scoped token read/write**, which keeps the blast radius of any web-layer bug inside the RLS guardrails. (Other parts of the system — the ingestion pipeline, the GitHub token pool manager, admin jobs — legitimately use `service_role`. They are kept out of the web layer's module graph by the `dependency-cruiser` rules defined in Chunk C §13, which forbid importing `createServiceClient` from anywhere under `app/**` except the OAuth callback route.)

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

Six security-sensitive functions and one Auth trigger live in this migration:

| # | Function                              | Called from                                             | Purpose                                                                       |
| - | ------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 | `handle_new_user()`                   | Auth trigger on `auth.users` INSERT                      | Creates `user_profiles` row from OAuth metadata on first sign-in              |
| 2 | `upsert_user_oauth_token()`           | Authenticated server code (OAuth callback)              | Stores encrypted GitHub `provider_token` for later fork API calls             |
| 3 | `record_fork_event()`                 | Authenticated server code (after GitHub fork API success) | Records a fork; entry point for review eligibility                            |
| 4 | `create_review_with_fork_check()`     | Authenticated server code (review submit)              | **Key security function.** Verifies fork exists, then inserts review          |
| 5 | `mark_oauth_token_revoked()`          | Authenticated server code (after GitHub 401 response)  | Marks caller's OAuth token as revoked so the UI can prompt re-auth            |
| 6 | `get_my_oauth_token_encrypted()`      | Authenticated server code (fork flow)                   | Returns caller's encrypted GitHub token — read counterpart to #2              |

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
```

### 6.3 File `000012_storage_buckets_and_policies.sql`

Per §3.1 migration layout, this is the final Foundation migration. It creates the two Supabase Storage buckets referenced by `repo_assets.storage_key` and `review_assets.storage_key`, then attaches RLS policies on `storage.objects` so uploads are gated by the same ownership model as the application tables.

**Why this is a migration, not a provisioning step.** Decision D7 requires that `supabase db reset` in CI produces a working stack from scratch. Bucket creation and storage policies are migration-layer state — if they lived only in dashboard config or a one-off shell script, CI would see a stack where rows point at nonexistent buckets, and the `review_assets_owner_insert` test in §19a would fail with an error unrelated to the code under test.

**Path conventions.** These string formats are enforced by the `lib/storage/` helpers in Chunk C §11; the RLS policies below verify them:

- `repo-assets/{repo_id}/{kind}/{filename}` — service role writes only; public reads
- `review-assets/{user_id}/{review_id}/{ordering}.{ext}` — authenticated owner writes/deletes; public reads

The `{user_id}` prefix on `review-assets` is what lets `storage.foldername(name)[1] = auth.uid()::text` enforce ownership without a join — the path itself carries the claim, and the RLS policy verifies it against the `reviews` row.

```sql
-- ══════════════════════════════════════════════════════════════════════
-- Storage buckets
--   repo-assets:   marketplace thumbnails (readme_gif, readme_image,
--                  demo_screenshot, ai_generated)
--   review-assets: user-uploaded review images (up to 5 per review,
--                  enforced by the trigger in 000004)
-- Both buckets are public-read; writes are gated by policies below.
-- ══════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
  values ('repo-assets', 'repo-assets', true)
  on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
  values ('review-assets', 'review-assets', true)
  on conflict (id) do nothing;

-- NOTE on migration idempotency:
-- The ON CONFLICT DO NOTHING pattern above is safe to replay but it is
-- ONE-SHOT: a future migration that needs to change a bucket's `public`
-- flag, name, or any other setting MUST use an explicit UPDATE, not a
-- re-INSERT. Example for a later migration:
--
--   update storage.buckets set public = false where id = 'repo-assets';

-- ══════════════════════════════════════════════════════════════════════
-- storage.objects policies
-- RLS on storage.objects is enabled by Supabase default; we only write
-- policies here.
-- ══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- repo-assets bucket
-- ──────────────────────────────────────────────────────────────────────
-- Public read: anyone can fetch marketplace thumbnails.
create policy repo_assets_public_read
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'repo-assets');

-- Writes: service role only (no policies for anon/authenticated).
-- Pipeline code calls createServiceClient() to upload.

-- ──────────────────────────────────────────────────────────────────────
-- review-assets bucket
-- ──────────────────────────────────────────────────────────────────────
-- Public read: anyone can view review images.
create policy review_assets_public_read
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'review-assets');

-- Authenticated owner INSERT.
-- Predicate (all four must hold):
--   1) Exactly two folder segments: {user_id}/{review_id}/
--   2) First segment equals the caller's user id
--   3) Filename matches '0.ext' through '4.ext' with a safe extension
--      (mirrors review_assets.ordering check 0..4 from 000004)
--   4) Second segment is a review_id owned by the caller
-- Rejecting paths like '{uid}/{rid}/a/b.png' or '{uid}/{rid}/random.png'
-- prevents an authenticated user from scattering unrelated files under
-- their own path prefix.
create policy review_assets_owner_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'review-assets'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and storage.filename(name) ~ '^[0-4]\.(png|jpe?g|webp|gif)$'
    and exists (
      select 1 from public.reviews rv
      where rv.id::text = (storage.foldername(name))[2]
        and rv.user_id = auth.uid()
    )
  );

-- Authenticated owner DELETE: same ownership predicate as INSERT.
create policy review_assets_owner_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'review-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.reviews rv
      where rv.id::text = (storage.foldername(name))[2]
        and rv.user_id = auth.uid()
    )
  );

-- No UPDATE policy: asset files are immutable at the storage layer.
-- To replace an image, delete and re-insert — mirrors the application
-- rule for review_assets rows (see 000004).

-- ══════════════════════════════════════════════════════════════════════
-- Storage cleanup triggers
-- When a repo_assets or review_assets row is deleted (directly or via
-- cascade from parent row deletion), delete the underlying object in
-- the corresponding storage bucket. Without this, every deleted row
-- leaks its storage object indefinitely — a critical data-retention bug.
--
-- The function is SECURITY DEFINER because authenticated context cannot
-- write to storage.objects directly. Asset rows with NULL storage_key
-- (e.g., kind='readme_gif' with external_url, or kind='ai_generated')
-- are skipped — there is no bucket object to clean up.
--
-- tg_argv[0] carries the bucket name, so one shared function handles
-- both tables.
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.cleanup_storage_object_on_asset_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.storage_key is null then
    return old;  -- external_url or ai_generated asset — nothing to clean up
  end if;

  delete from storage.objects
  where bucket_id = tg_argv[0]
    and name = old.storage_key;

  return old;
end;
$$;

create trigger trg_review_assets_cleanup_storage
  after delete on public.review_assets
  for each row
  execute function public.cleanup_storage_object_on_asset_delete('review-assets');

create trigger trg_repo_assets_cleanup_storage
  after delete on public.repo_assets
  for each row
  execute function public.cleanup_storage_object_on_asset_delete('repo-assets');
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

Users cannot delete their own `fork_events` rows. If a user un-forks on GitHub, we don't notice — their ability to write reviews on that repo remains. A bad actor can fork → write glowing review → un-fork, and the review stays.

**Options:**

1. **Accept for MVP** — unforking is rare; review integrity is best-effort at launch.
2. **Post-MVP background job** — periodic check against GitHub API updates state on `fork_events`. The job needs multi-field state (last check time, consecutive misses, detection source), so this is a proper schema migration with its own columns and a partial index — not a single reserved column. Review list queries filter on the new state; average-rating calculations update accordingly; the UX decides whether to hide, badge, or strike through an un-forked review.
3. **Live check on review submit** — the review function calls GitHub API before insert. Rejected: adds latency and flakiness on the review-submit hot path.

**My recommendation: option 1 for MVP.** Option 2 is a deliberate post-launch feature that ships with its own migration + background job + UX decision. We do **not** pre-reserve a column in Foundation: a prior reviewer pass showed a single `unforked_detected_at timestamptz` was too narrow a shape, and reserving the wrong shape is worse than reserving none. See the NOTE at the bottom of §3.6 `fork_events`.

---

## 8. Directory layout

```
vibeshelf/
├── app/                               # Next.js App Router
│   ├── layout.tsx                     # Root layout (shadcn/ui providers)
│   ├── page.tsx                       # Marketplace home (skeleton for sub-project #4)
│   └── (auth)/
│       └── callback/
│           └── route.ts               # Supabase Auth + token storage (§10.4)
│
├── lib/
│   ├── env.ts                         # zod-validated env with scope tags (§9)
│   ├── db/
│   │   ├── index.ts                   # Factory exports
│   │   ├── anon-client.ts             # createAnonClient() (§10.1)
│   │   ├── user-client.ts             # createUserClient() (§10.2)
│   │   ├── service-client.ts          # createServiceClient() (§10.3)
│   │   └── database.types.ts          # Generated by `supabase gen types`
│   ├── storage/
│   │   ├── index.ts                   # Typed helpers (§13)
│   │   ├── repo-assets.ts
│   │   └── review-assets.ts
│   ├── crypto/
│   │   └── tokens.ts                  # encryptToken / decryptToken (§12)
│   ├── pipeline/
│   │   ├── runJob.ts                  # Durable job wrapper (§11)
│   │   ├── trace.ts                   # OTel span helpers
│   │   └── jobs/
│   │       └── echo.ts                # No-op example job (Foundation smoke test)
│   └── types/
│       ├── database.ts                # Re-exports from lib/db/database.types
│       ├── jobs.ts                    # JobInput, JobOutput, JobContext contracts
│       └── assets.ts                  # AssetKind, StoragePath branded types
│
├── supabase/
│   ├── config.toml                    # Supabase CLI config
│   └── migrations/                    # 000001 – 000012 (Chunks A + B)
│
├── tests/
│   ├── unit/                          # Pure-function tests (no DB)
│   ├── integration/                   # Against `supabase start` local stack
│   │   ├── rls/                       # §19a policy matrix
│   │   ├── security-definer/          # §6 function tests
│   │   └── run-job.test.ts            # §11 runJob lifecycle
│   ├── e2e/                           # Playwright — sign-in flow only
│   │   └── sign-in.spec.ts
│   ├── fixtures/                      # Lint-guardrail fixtures (§14, §20)
│   │   ├── bad-pipeline-import.ts     # Must fail depcruise
│   │   └── bad-process-env.ts         # Must fail eslint
│   └── helpers/
│       ├── rls.ts                     # JWT-minting test client helper
│       └── test-user.ts               # Create synthetic auth.users rows for tests
│
├── .github/
│   └── workflows/
│       └── ci.yml                     # §15
│
├── dependency-cruiser.cjs             # §14.1
├── eslint.config.js                   # §14.2
├── biome.json                         # §14.2 (primary formatter/linter)
├── tsconfig.json
├── next.config.ts                     # Next.js 16+ App Router config
├── package.json
├── pnpm-lock.yaml
├── .env.example                       # Template (no real values)
└── .gitignore
```

**Purpose per directory:**

- **`app/`** — Next.js App Router only. Route handlers, layouts, page components. Imports from `lib/` are allowed; direct Supabase client instantiation is not.
- **`lib/env.ts`** — The **only** module that reads `process.env.*`. Exports a typed `env` const. Enforced by ESLint `no-restricted-syntax` rule (§14.2).
- **`lib/db/`** — Single source of truth for all Supabase client instances. Factory pattern. Generated `Database` type lives here.
- **`lib/storage/`** — Single source of truth for all Supabase Storage access. Mirrors `lib/db/`.
- **`lib/crypto/`** — Token encryption helpers. Narrow import set (OAuth callback + pipeline fork job only).
- **`lib/pipeline/`** — Ingestion + scoring + classification logic. **Zero** imports from `app/` or `next/*`. Enforced by dep-cruiser (§14.1).
- **`lib/types/`** — Shared types. **Zero** framework dependencies.
- **`supabase/`** — Migrations + CLI config. Source of truth for DB schema.
- **`tests/`** — Vitest (unit, integration) + Playwright (e2e). The only fixture-like code in `tests/` is shared helpers; deliberately-broken lint guardrail fixtures live at `lib/**/__fixtures__/` so dep-cruiser and ESLint see them with the correct path context (see §14.2).

### 8.1 TypeScript configuration

```json
// tsconfig.json (relevant excerpt)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] },
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["**/*.ts", "**/*.tsx", "next-env.d.ts"],
  "exclude": ["node_modules", "**/__fixtures__/**"]
}
```

- **`@/*` path alias** — every `import { env } from "@/lib/env"` and `import { ... } from "@/lib/db"` in Chunks C and D resolves through this single mapping. Never rely on deep relative paths (`../../lib/env`).
- **`moduleResolution: "bundler"`** — required for Next.js 16 App Router package exports.
- **`**/__fixtures__/**` excluded from `include`** — the negative-test fixtures in §14.2 are intentionally broken TypeScript that must not fail `tsc`. They are still visible to dep-cruiser and ESLint when those tools are invoked on the explicit fixture paths.

---

## 9. `lib/env.ts`

Only module in the entire repo that reads `process.env.*`. Uses `zod` for validation at module load (throws on missing/invalid env, catching misconfiguration before any code runs). Each secret is tagged with a `scope` per Design-for-Later rules 5 and 7.

```ts
// lib/env.ts
import { z } from "zod"

const envSchema = z.object({
  // ─── Supabase ───────────────────────────────────────────────────────
  // scope: both — browser-safe project URL + anon key
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),

  // scope: pipeline — service role bypasses RLS. NEVER imported from app/.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // ─── Token encryption ───────────────────────────────────────────────
  // scope: both — AES-256-GCM key for encrypt/decrypt of provider_token.
  // Expected format: base64(32 random bytes). Accepts both standard base64
  // (44 chars with `=` padding) and base64url (43 chars, no padding, uses
  // `-_` instead of `+/`). Node's `Buffer.from(x, "base64")` decodes both,
  // so the zod validator must accept both — otherwise an operator pulling
  // a key from a secrets manager that stores base64url hits a cryptic error.
  // Generated via: openssl rand -base64 32
  TOKEN_ENCRYPTION_KEY_V1: z.string().regex(
    /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/,
    {
      message: "TOKEN_ENCRYPTION_KEY_V1 must be base64(32 bytes) — standard (44 chars with '=') or base64url (43 chars, no padding)",
    },
  ),

  // ─── GitHub OAuth ───────────────────────────────────────────────────
  // scope: web — OAuth dance + callback encryption
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),

  // ─── AI (reserved for sub-project #3) ───────────────────────────────
  // scope: pipeline — declared so env loader catches missing config early.
  GEMINI_API_KEY: z.string().optional(),

  // ─── Vercel OIDC (auto-injected) ────────────────────────────────────
  // scope: both — set automatically on deployed functions; locally,
  //               `vercel env pull` writes it and it expires in ~12h.
  VERCEL_OIDC_TOKEN: z.string().optional(),
})

// Throws at module load on missing/invalid env. It's all-or-nothing.
export const env = envSchema.parse(process.env)

export type Env = z.infer<typeof envSchema>

// Scope manifest — machine-readable, used by a CI script to verify that
// every secret referenced in code is declared here. Must stay in sync
// with the comments above. See §15 for the CI script.
export const envScope = {
  NEXT_PUBLIC_SUPABASE_URL: "both",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "both",
  SUPABASE_SERVICE_ROLE_KEY: "pipeline",
  TOKEN_ENCRYPTION_KEY_V1: "both",
  GITHUB_CLIENT_ID: "web",
  GITHUB_CLIENT_SECRET: "web",
  GEMINI_API_KEY: "pipeline",
  VERCEL_OIDC_TOKEN: "both",
} as const satisfies Record<keyof Env, "web" | "pipeline" | "both">
```

**Key rules:**

1. **Only `lib/env.ts` reads `process.env.*`.** Enforced by ESLint `no-restricted-syntax` (§14.2).
2. **Every new secret gets a `scope` entry.** Enforced by a CI script that parses the `envScope` literal.
3. **`optional()` is a last resort.** Prefer required + sensible defaults. `GEMINI_API_KEY` and `VERCEL_OIDC_TOKEN` are optional because they're truly optional at runtime (sub-project #3 not built; OIDC only exists on Vercel).
4. **No `NEXT_PUBLIC_` leakage of secrets.** The two `NEXT_PUBLIC_*` fields are explicitly public by Supabase's design (anon key is RLS-gated). Every other field is server-only.

---

## 10. `lib/db/` Supabase client factories

Three factories, one per role context. All clients are typed against the generated `Database` type from `lib/db/database.types.ts` so the query builder's autocomplete works across the codebase.

### 10.1 `createAnonClient()`

Public browsing — anon JWT, RLS-gated to published content. Used by server components that render marketplace pages.

```ts
// lib/db/anon-client.ts
import { createClient } from "@supabase/supabase-js"
import { env } from "@/lib/env"
import type { Database } from "./database.types"

export function createAnonClient() {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } },
  )
}
```

### 10.2 `createUserClient()`

Authenticated context — the request's Supabase Auth session JWT is attached so `auth.uid()` resolves in RLS policies and `SECURITY DEFINER` functions. Uses `@supabase/ssr` for Next.js cookie handling.

```ts
// lib/db/user-client.ts
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { env } from "@/lib/env"
import type { Database } from "./database.types"

export async function createUserClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        },
      },
    },
  )
}
```

### 10.3 `createServiceClient()`

Service role — bypasses RLS. **Narrowly scoped by dep-cruiser rule `no-service-client-in-app-except-callback` (§14.1).** Only importable from:

- `lib/pipeline/**` — pipeline jobs write `repos`, `repo_scores`, `repo_tags`, `repo_assets`, `pipeline_runs`, `github_tokens`.
- `app/(auth)/callback/route.ts` — exceptionally, for any operation the callback needs outside SECURITY DEFINER (currently none; reserved for future).

All other `app/**` code is blocked at lint-time from importing `createServiceClient`.

```ts
// lib/db/service-client.ts
import { createClient } from "@supabase/supabase-js"
import { env } from "@/lib/env"
import type { Database } from "./database.types"

export function createServiceClient() {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  )
}
```

```ts
// lib/db/index.ts
export { createAnonClient } from "./anon-client"
export { createUserClient } from "./user-client"
export { createServiceClient } from "./service-client"
export type { Database } from "./database.types"
```

### 10.4 OAuth callback flow

Concrete sequence for how the GitHub `provider_token` reaches `github_oauth_tokens`:

```
1. User clicks "Sign in with GitHub" in the UI
   ↓
2. Redirect to Supabase Auth's /auth/v1/authorize?provider=github
   ↓
3. GitHub OAuth consent page (scopes: public_repo)
   ↓
4. GitHub redirects back to Supabase with an auth code
   ↓
5. Supabase exchanges the code for a session, then redirects to our
   /auth/callback route with ?code=... in the URL
   ↓
6. app/(auth)/callback/route.ts runs:
   a. const supabase = await createUserClient()
   b. const { data: { session }, error } = await supabase.auth
        .exchangeCodeForSession(code)
   c. if (error || !session?.provider_token)
        → redirect to /sign-in?error=...
   d. const encrypted = encryptToken(session.provider_token, 1)
        // from lib/crypto/tokens.ts; V1 is the current key version
   e. const { error: rpcError } = await supabase.rpc(
        'upsert_user_oauth_token',
        {
          p_token_encrypted: encrypted,
          p_token_key_version: 1,
          p_scopes: ['public_repo'],
        },
      )
   f. if (rpcError)
        → log + redirect to /sign-in?error=token-storage
   g. redirect to /
```

**Key notes on this flow:**

1. **Entire flow runs in the authenticated user context.** `createUserClient()` carries the session cookies, so `auth.uid()` inside `upsert_user_oauth_token` resolves to the signing-in user. **No service_role client is instantiated** — this is what makes the symmetric SECURITY DEFINER pattern hold.

2. **`provider_token` lives in memory briefly.** Read from session, encrypted, handed to the RPC. Never logged, never persisted outside the encrypted `bytea` column.

3. **Decryption lives in `lib/crypto/tokens.ts` (§12).** Later, when the fork flow calls `get_my_oauth_token_encrypted`, the returned `bytea` is decrypted in application code using the same `TOKEN_ENCRYPTION_KEY_V{n}`.

4. **Decryption failure recovery** *(deferred to sub-project #5 fork flow, but spec'd here for coherence):*
   - If `decryptToken()` throws (key mismatch, corrupted bytes, malformed IV), the fork flow must call `mark_oauth_token_revoked()` and prompt the user to re-authenticate. **Do not retry the fork.**
   - If the fork's GitHub API call returns 401, same path: call `mark_oauth_token_revoked()` and prompt re-auth.
   - If `get_my_oauth_token_encrypted` raises `P0002` (no active token), the fork flow maps that to "prompt re-auth" and never calls GitHub at all.

5. **Token key rotation.** `token_key_version = 1` is hardcoded today because `TOKEN_ENCRYPTION_KEY_V1` is the only key. When V2 is introduced:
   - Encryption always uses the **newest** version (const in `lib/crypto/tokens.ts`).
   - Decryption looks up by the stored `token_key_version`, so V1 rows continue to decrypt correctly.
   - No data migration needed. Retire V1 in a later release once all active sessions have re-authed under V2.

---

## 11. `lib/pipeline/runJob.ts` wrapper

All scheduled pipeline work runs inside `runJob`. This is the **only** entry point from Next.js cron API routes into `lib/pipeline/jobs/*`, enforced by dep-cruiser rule `pipeline-jobs-via-runjob-only` (§14.1).

### 11.1 Contract

```ts
// lib/pipeline/runJob.ts
import { createServiceClient } from "@/lib/db/service-client"
import { startSpan } from "./trace"

export type JobInput = Record<string, unknown>
export type JobOutput = Record<string, unknown>

export interface JobContext {
  readonly runId: string
  readonly parentRunId: string | null
  readonly db: ReturnType<typeof createServiceClient>
  metric(name: string, value: number | string): void
  spawn<I extends JobInput, O extends JobOutput>(
    childJobName: string,
    childInput: I,
    childFn: (childCtx: JobContext) => Promise<O>,
  ): Promise<O>
}

export async function runJob<I extends JobInput, O extends JobOutput>(
  jobName: string,
  input: I,
  fn: (ctx: JobContext) => Promise<O>,
  options?: { parentRunId?: string },
): Promise<O>
```

### 11.2 Behavior

1. **Insert `pipeline_runs` row on entry** with `job_name`, `input`, `status='running'`, a fresh `trace_id` from OTel, and `parent_run_id` (from `options.parentRunId` if present). The inserted row's id becomes `ctx.runId`.
2. **Start an OTel span** wrapping `fn(ctx)`. Span name = `job:{jobName}`. Span attributes include `run_id`, `parent_run_id`.
3. **Wrap `fn(ctx)` in `try / catch`.** The context exposes:
   - `db` — a service-role client (already created, shared for the run)
   - `metric(name, value)` — accumulates into a local object returned with the success update
   - `spawn(childJobName, childInput, childFn)` — recursively calls `runJob` with `parentRunId` set so child runs link via `pipeline_runs.parent_run_id`; enables D17 fan-out
4. **On success (inside `try`):** update the row to `status='success'`, `finished_at = now()`, `metrics = {...accumulated}`. End span normally. Return `fn`'s result.
5. **On error (inside `catch`):** update the row to `status='failed'`, `finished_at = now()`, `error_message = err.message`, `error_stack = err.stack`. Record exception on span. **Re-throw.** Caller decides whether to retry.

**Deliberate: `try / catch`, not `try / finally`.** Wrapping the terminal row update in `finally` would swallow errors from the update itself, masking the original job failure. Both branches update the row before returning/re-throwing; any failure in the update step propagates up.

### 11.2.1 Zombie `running` rows — known limitation

If the Node process dies **between** the initial row insert (step 1) and the terminal update (step 4 or 5) — e.g., Vercel function hard timeout, OOM kill, SIGKILL, cold-start deadline — the `pipeline_runs` row is left in `status='running'` forever. Foundation does **not** ship a reaper for these zombie rows.

Sub-project #3 (scoring/evaluation pipeline) is responsible for adding a sweeper job that transitions stale `running` rows to `failed`:

```sql
update pipeline_runs
  set status = 'failed',
      finished_at = now(),
      error_message = 'process killed or timed out (zombie sweep)'
  where status = 'running'
    and started_at < now() - interval '30 minutes';
```

This is deliberately deferred to sub-project #3 because (a) Foundation has only a no-op echo job, so zombies cannot accumulate in practice, and (b) the stale threshold depends on the longest legitimate job, which Foundation cannot yet know.

### 11.3 Example job + smoke test

Foundation ships exactly one job — a no-op echo — to prove the wrapper round-trips correctly. Real jobs land in sub-projects #2 and #3.

```ts
// lib/pipeline/jobs/echo.ts
import type { JobContext } from "../runJob"

export interface EchoInput { message: string }
export interface EchoOutput { echoed: string; at: string }

export async function echoJob(
  ctx: JobContext,
  input: EchoInput,
): Promise<EchoOutput> {
  ctx.metric("echo_count", 1)
  return { echoed: input.message, at: new Date().toISOString() }
}
```

Integration test (§19): `runJob("echo", {message: "hi"}, (ctx) => echoJob(ctx, {message: "hi"}))` asserts that `pipeline_runs` transitions `running → success` with `metrics = {echo_count: 1}` and no error fields populated.

**Local-stack wiring for the integration test.** The test runs against the `supabase start` local stack. Vitest's `globalSetup` (configured in Chunk D §19) reads `SUPABASE_SERVICE_ROLE_KEY` from `.env.test.local`, which the CI setup step (Chunk D §15) populates via:

```bash
supabase status -o json | jq -r '.SERVICE_ROLE_KEY' > .env.test.local.tmp
echo "SUPABASE_SERVICE_ROLE_KEY=$(cat .env.test.local.tmp)" > .env.test.local
```

When `lib/env.ts` loads during the test, it picks up the local-stack service role key. The same seam is used for RLS tests (§19a).

---

## 12. `lib/crypto/tokens.ts`

AES-256-GCM encrypt/decrypt for the GitHub `provider_token`. Decouples key material from DB.

```ts
// lib/crypto/tokens.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { env } from "@/lib/env"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const TAG_LENGTH = 16

function getKey(version: number): Buffer {
  if (version === 1) return Buffer.from(env.TOKEN_ENCRYPTION_KEY_V1, "base64")
  throw new Error(`tokens: unknown key version ${version}`)
}

// Format: IV(12) || TAG(16) || CIPHERTEXT
export function encryptToken(plaintext: string, version: number): Buffer {
  const key = getKey(version)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

export function decryptToken(encrypted: Buffer, version: number): string {
  const key = getKey(version)
  const iv = encrypted.subarray(0, IV_LENGTH)
  const tag = encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = encrypted.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8")
}
```

**Import allowlist:** `lib/crypto/tokens.ts` is importable from exactly two module paths:

1. `app/(auth)/callback/route.ts` — encrypts on sign-in
2. Any file under `lib/pipeline/**` that calls `get_my_oauth_token_encrypted` and decrypts the result (sub-project #5 fork flow)

Dep-cruiser rule `crypto-tokens-limited-import` (§14.1) blocks imports from everywhere else.

**Round-trip property test** (§19): `decryptToken(encryptToken("foo", 1), 1) === "foo"` for 100 random plaintexts.

---

## 13. `lib/storage/` helpers

Single boundary for all Supabase Storage access. Mirrors the `lib/db/` pattern. Dep-cruiser rule `storage-boundary` (§14.1) plus ESLint `no-restricted-syntax` forbid direct `supabase.storage.*` calls elsewhere.

```ts
// lib/storage/index.ts
export { uploadRepoAsset, signedRepoAssetUrl } from "./repo-assets"
export {
  uploadReviewImage,
  deleteReviewImage,
  reviewImagePublicUrl,
} from "./review-assets"
```

```ts
// lib/storage/repo-assets.ts
import { createServiceClient } from "@/lib/db/service-client"
import type { AssetKind } from "@/lib/types/assets"

const BUCKET = "repo-assets"

export async function uploadRepoAsset(
  repoId: string,
  kind: AssetKind,
  filename: string,
  data: Blob,
): Promise<{ storageKey: string }> {
  const storageKey = `${repoId}/${kind}/${filename}`
  const supabase = createServiceClient()
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storageKey, data, { upsert: false })
  if (error) throw error
  return { storageKey }
}

export async function signedRepoAssetUrl(
  storageKey: string,
  ttlSec = 3600,
): Promise<string> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storageKey, ttlSec)
  if (error) throw error
  return data.signedUrl
}
```

```ts
// lib/storage/review-assets.ts
import { createUserClient } from "@/lib/db/user-client"
import { env } from "@/lib/env"

const BUCKET = "review-assets"
type Extension = "png" | "jpg" | "jpeg" | "webp" | "gif"

export async function uploadReviewImage(
  userId: string,
  reviewId: string,
  ordering: 0 | 1 | 2 | 3 | 4,
  extension: Extension,
  data: Blob,
): Promise<{ storageKey: string }> {
  const storageKey = `${userId}/${reviewId}/${ordering}.${extension}`
  const supabase = await createUserClient()
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storageKey, data, { upsert: false })
  if (error) throw error
  return { storageKey }
}

export async function deleteReviewImage(storageKey: string): Promise<void> {
  const supabase = await createUserClient()
  const { error } = await supabase.storage.from(BUCKET).remove([storageKey])
  if (error) throw error
}

export function reviewImagePublicUrl(storageKey: string): string {
  // review-assets is a public bucket; this is a pure path builder.
  // Read NEXT_PUBLIC_SUPABASE_URL from `env` (lib/env.ts), NEVER directly
  // from process.env — DFL rule 5 enforced by ESLint `no-restricted-syntax`.
  return `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storageKey}`
}
```

**Path convention enforcement.** The helpers construct paths matching the RLS policy convention in §6.3:

- `repo-assets/{repo_id}/{kind}/{filename}`
- `review-assets/{user_id}/{review_id}/{ordering}.{ext}`

The Storage policies verify that `auth.uid()` matches the first path segment and that the review is owned by the caller. A mismatch returns a 403; the helper surfaces it as a thrown error.

**Note on storage-object cleanup.** The Postgres triggers `trg_review_assets_cleanup_storage` and `trg_repo_assets_cleanup_storage` defined in §6.3 handle the "orphaned storage object on row delete" problem at the DB layer. The `deleteReviewImage` helper exists primarily for explicit user-initiated deletes (remove-image button on a review). It does **not** need to duplicate the cleanup — the trigger fires when the `review_assets` row cascades.

---

## 14. Lint boundary enforcement

Two complementary tools. `dependency-cruiser` enforces module-level import rules; ESLint enforces identifier-level syntax rules. Biome is the primary formatter/linter for everything else.

### 14.1 `dependency-cruiser.cjs`

Run via `pnpm depcruise src/ lib/ app/` in CI. Every rule cites the Design-for-Later rule number from `docs/architecture/future-separation-plan.md`.

```js
// dependency-cruiser.cjs
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ─── DFL rule 1 — lib/pipeline/ is self-contained ────────────────
    {
      name: "no-pipeline-imports-app",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "^app/" },
      comment: "DFL rule 1: pipeline must not import from app/",
    },
    {
      name: "no-pipeline-imports-framework",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "^(next|react)(/.*)?$" },
      comment: "DFL rule 1: pipeline is framework-free",
    },

    // ─── DFL rule 3 — lib/types/ is framework-free ───────────────────
    {
      name: "no-types-imports-framework",
      severity: "error",
      from: { path: "^lib/types/" },
      to: { path: "^(next|react|server-only)(/.*)?$" },
      comment: "DFL rule 3: shared types must not depend on framework",
    },

    // ─── DFL rule 9 — no cache directives in pipeline ────────────────
    {
      name: "no-pipeline-cache-directives",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "^next/cache$" },
      comment: "DFL rule 9: pipeline must not use Next.js cache APIs",
    },

    // ─── DFL rule 2 — DB access through lib/db/ only ─────────────────
    {
      name: "pipeline-db-via-lib-db-only",
      severity: "error",
      from: {
        path: "^lib/pipeline/",
        pathNot: "^lib/pipeline/.*\\.test\\.",
      },
      to: { path: "^@supabase/supabase-js$" },
      comment: "DFL rule 2: pipeline imports DB client from lib/db/, not @supabase/supabase-js directly",
    },

    // ─── DFL rule 8 — Storage boundary ───────────────────────────────
    // Dep-cruiser cannot see `.storage` member access; it enforces the
    // import boundary. ESLint (§14.2) handles the identifier-level rule.
    //
    // lib/db/** is CARVED OUT of this rule because the three client
    // factories (anon-client.ts, user-client.ts, service-client.ts) must
    // import createClient from @supabase/supabase-js — that is the whole
    // point of having a lib/db/ boundary. Without this carve-out, the
    // rule would false-positive on the factories themselves.
    {
      name: "supabase-js-import-boundary",
      severity: "error",
      from: { pathNot: "^lib/(storage|db)/" },
      to: { path: "^@supabase/supabase-js$", dependencyTypes: ["import"] },
      comment: "DFL rule 8 + rule 2: @supabase/supabase-js importable only from lib/db/ and lib/storage/",
    },

    // ─── Foundation rule F1 — service_role client scope ──────────────
    // Initially the OAuth callback was carved out as an allowed importer.
    // A reviewer pass found the callback uses createUserClient() exclusively
    // (§10.4 flow), so the carve-out was dead code — removed. If a concrete
    // caller under app/ ever needs service_role, re-add it with a named
    // justification (and a code comment pointing to this rule).
    {
      name: "no-service-client-in-app",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/db/service-client" },
      comment: "F1: createServiceClient is server-only; imported only from lib/pipeline/runJob.ts (never from app/)",
    },

    // ─── Foundation rule F2 — crypto/ import scope ───────────────────
    {
      name: "crypto-tokens-limited-import",
      severity: "error",
      from: {
        pathNot: "^(app/\\(auth\\)/callback/|lib/pipeline/)",
      },
      to: { path: "^lib/crypto/tokens" },
      comment: "F2: tokens.ts importable only from OAuth callback and lib/pipeline/",
    },

    // ─── Foundation rule F3 — pipeline jobs via runJob only ──────────
    {
      name: "pipeline-jobs-via-runjob-only",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/pipeline/jobs/" },
      comment: "F3: app invokes pipeline only via runJob wrapper, not direct job imports",
    },

    // ─── Foundation rule F4 — jobs use ctx.db, not createServiceClient
    // runJob creates ONE service-role client per run and hands it off
    // via ctx.db. Jobs that spawn their own client break the
    // "one client per run" invariant used by OTel span attribution,
    // connection accounting, and future worker-side pool sizing.
    {
      name: "pipeline-jobs-use-ctx-db-only",
      severity: "error",
      from: { path: "^lib/pipeline/jobs/" },
      to: { path: "^lib/db/service-client" },
      comment: "F4: pipeline jobs access DB via ctx.db only (runJob owns the single service-role client)",
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
}
```

**Rule-to-DFL mapping:**

| Dep-cruiser rule                    | Enforces DFL rule #   |
| ----------------------------------- | --------------------- |
| `no-pipeline-imports-app`           | 1                     |
| `no-pipeline-imports-framework`     | 1 (continuation)      |
| `no-types-imports-framework`       | 3                     |
| `no-pipeline-cache-directives`      | 9 (imports only — see §14.2 for directive ban) |
| `pipeline-db-via-lib-db-only`       | 2                     |
| `supabase-js-import-boundary`       | 8 + 2 (combined)      |
| `no-service-client-in-app`          | 4 (extended)          |
| `crypto-tokens-limited-import`      | F2 (new)              |
| `pipeline-jobs-via-runjob-only`     | 6                     |
| `pipeline-jobs-use-ctx-db-only`     | F4 (new)              |

**DFL rules not covered by dep-cruiser (ESLint handles them):**

- **Rule 5** — `process.env.*` read restriction. Dep-cruiser operates on module imports, not identifier access. Enforced by ESLint `no-restricted-syntax` (§14.2).
- **Rule 7** — secret scope manifest. Enforced by a CI script that parses `lib/env.ts` `envScope` literal (Chunk D §15).
- **Rule 9 (directive portion)** — `'use cache'` and `'use server'` directives. These are string literals, not module imports. Enforced by ESLint `no-restricted-syntax` on `lib/pipeline/**` (§14.2).

### 14.2 ESLint + Biome

**Biome is primary.** It handles formatting, import ordering, unused vars, React rules, and style. Fast and Rust-based.

**ESLint handles three specific rules** that Biome doesn't cover:

1. **`no-restricted-syntax` banning `process.env.*` outside `lib/env.ts`** — enforces DFL rule 5.
2. **`no-restricted-imports` banning `next/*` inside `lib/pipeline/` and `lib/types/`** — earlier feedback in the IDE, complements dep-cruiser.
3. **`@next/eslint-plugin-next`** — Next.js-specific rules (image optimization, link rules, etc.).

```js
// eslint.config.js
import nextPlugin from "@next/eslint-plugin-next"

// Shared selectors for process.env.* (DFL rule 5)
// Covers direct member access AND computed string-literal access.
// Known gap: aliasing via `const p = process; p.env.X` is NOT caught —
// ESLint cannot flow-track identifiers without type-aware rules.
// Code review + dep-cruiser layering provide the additional coverage.
const processEnvSelectors = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: "Read env vars via `@/lib/env` only. Add new vars to the zod schema there.",
  },
  {
    selector: "MemberExpression[object.name='process'][computed=true][property.value='env']",
    message: "Read env vars via `@/lib/env` only (computed access is also banned).",
  },
]

export default [
  nextPlugin.configs.recommended,

  // DFL rule 5: process.env.* allowed only inside lib/env.ts (global)
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["lib/env.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...processEnvSelectors],
    },
  },

  // DFL rule 9 (directive portion): 'use cache' and 'use server'
  // directives banned inside lib/pipeline/**.
  // Dep-cruiser cannot detect string-literal directives (only imports),
  // so ESLint AST matching is the only layer that catches this.
  //
  // IMPORTANT: ESLint flat-config rules REPLACE per-config, not merge.
  // We must repeat the processEnvSelectors here so lib/pipeline/ files
  // still get the env ban.
  {
    files: ["lib/pipeline/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...processEnvSelectors,
        {
          selector: "ExpressionStatement > Literal[value='use cache']",
          message: "DFL rule 9: `'use cache'` directive is forbidden inside lib/pipeline/ (framework-coupled API).",
        },
        {
          selector: "ExpressionStatement > Literal[value='use server']",
          message: "DFL rule 9: `'use server'` directive is forbidden inside lib/pipeline/ (framework-coupled API).",
        },
      ],
    },
  },

  // Framework imports banned inside pipeline and types
  {
    files: ["lib/pipeline/**/*.ts", "lib/types/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["next", "next/*"],
              message: "Framework-free: use lib/types/ + plain TS only.",
            },
            {
              group: ["react", "react-*"],
              message: "Framework-free: no React inside lib/pipeline or lib/types.",
            },
          ],
        },
      ],
    },
  },
]
```

```json
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "error" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

**Test fixtures for CI** (see §20 acceptance criteria 5 and 6):

The fixtures are deliberately-broken code used by **negative tests** — a linter run that CI expects to **fail**, because if it passes, one of the boundary rules has been disabled or broken. Placing them correctly is the whole game: the fixture must match a rule's `from.path` (so the rule fires), but the normal `pnpm lint` command must skip them (so normal CI is green).

**Fixture locations:**

- `lib/pipeline/__fixtures__/bad-pipeline-import.ts` — contains `import { cookies } from 'next/headers'`. Placed inside `lib/pipeline/` so the `no-pipeline-imports-framework` rule sees it.
- `lib/__fixtures__/bad-process-env.ts` — contains `const x = process.env.SOME_VAR`. Placed outside `lib/env.ts` so the `no-restricted-syntax` rule sees it.

**The `__fixtures__` directory convention** is excluded from:

- `tsconfig.json` `include` → `tsc --noEmit` ignores them
- `next build` webpack (via `next.config.ts` rule) → they don't reach the bundle
- Normal `pnpm lint` command → they don't pollute standard lint output

They are **invoked only by explicit negative-test commands** below.

**Package.json scripts:**

```json
{
  "scripts": {
    "lint": "biome check && eslint . --ignore-pattern '**/__fixtures__/**' && depcruise -c dependency-cruiser.cjs --exclude '__fixtures__' src/ lib/ app/",
    "lint:neg:depcruise": "! depcruise -c dependency-cruiser.cjs lib/pipeline/__fixtures__/bad-pipeline-import.ts 2>/dev/null",
    "lint:neg:eslint": "! eslint lib/__fixtures__/bad-process-env.ts 2>/dev/null",
    "lint:neg": "pnpm lint:neg:depcruise && pnpm lint:neg:eslint"
  }
}
```

- `!` prefix (POSIX) **inverts** the exit code — success only if the linter fails.
- `2>/dev/null` suppresses the expected lint noise from CI logs.
- `pnpm lint:neg` runs as its own CI job step in Chunk D §15.
- **If someone disables a boundary rule**, `pnpm lint:neg` starts passing the positive lint → the negative assertion fails → CI blocks the PR. This is the self-checking property that makes the rules trustworthy.

---

## 15. CI workflow — `.github/workflows/ci.yml`

GitHub Actions runs on every pull request and every push to `main`. Eight jobs grouped by concern. Parallelism is aggressive; sequential dependencies only where necessary.

### 15.1 Job graph

```
                       setup
                         │
      ┌────────┬─────────┼─────────┬────────────────┐
      │        │         │         │                │
     lint   lint-neg  typecheck  unit          db-integration
                                                      │
                                                     e2e
                                                      │
                                                   deploy (main only)
```

- **`setup`** — primes the pnpm store cache so downstream jobs reuse it.
- **`lint`** — `biome check` + `eslint .` + `depcruise`. All exclude `**/__fixtures__/**`.
- **`lint-neg`** — runs `pnpm lint:neg`, which asserts the negative-test fixtures in `lib/**/__fixtures__/` STILL fail their intended rules (§14.2).
- **`typecheck`** — `tsc --noEmit`. Also catches DFL rule 7 violations via the `envScope satisfies Record<keyof Env, ...>` constraint in `lib/env.ts` — no separate job needed.
- **`unit`** — `vitest run tests/unit` (pure functions, no DB).
- **`db-integration`** — boots `supabase start`, runs `supabase db reset` to replay all migrations, diffs generated types against `lib/db/database.types.ts`, runs `tests/integration`.
- **`e2e`** — depends on `db-integration` passing. Spins up its own stack, builds, starts `pnpm start`, runs Playwright sign-in flow.
- **`deploy`** — `main` only, depends on all test jobs green. `vercel pull && vercel build --prod && vercel deploy --prebuilt --prod`.

### 15.2 Caching strategy

Three caches bring warm CI runs under ~90 seconds. Cold runs (no cache at all) are realistically **3–5 minutes** — the 8+ Supabase images total ~2 GB and pull time is dominant.

1. **pnpm store** — `actions/setup-node@v4` with `cache: pnpm`. Keyed on `pnpm-lock.yaml`.
2. **Supabase CLI** — `supabase/setup-cli@v1` caches the CLI tarball.
3. **Supabase Docker images** — **`docker save`/`docker load` tarball pattern** (NOT `actions/cache` on `/var/lib/docker` — that path is root-owned with active file locks and will corrupt or permission-fail). After the first successful `supabase start`, CI runs `docker save $(docker images -q) | gzip > /tmp/supabase-images.tar.gz` and caches the tarball via `actions/cache@v4` keyed on `hashFiles('supabase/config.toml')`. Downstream runs `docker load -i /tmp/supabase-images.tar.gz` before `supabase start` to skip pulls.

### 15.3 `.env.test.local` population

The `db-integration` and `e2e` jobs extract credentials from `supabase status -o json`:

```bash
SRK=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY')
ANON=$(supabase status -o json | jq -r '.ANON_KEY')
URL=$(supabase status -o json | jq -r '.API_URL')

# IMPORTANT: secrets are passed via `env:` block, NOT interpolated in the heredoc,
# to avoid `${{ secrets.* }}` appearing in command logs or artifact uploads.
# The step's env block (see §15.4 YAML) sets TOKEN_KEY as a masked env var.
printf '%s\n' \
  "NEXT_PUBLIC_SUPABASE_URL=$URL" \
  "NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON" \
  "SUPABASE_SERVICE_ROLE_KEY=$SRK" \
  "TOKEN_ENCRYPTION_KEY_V1=$TOKEN_KEY" \
  "GITHUB_CLIENT_ID=test-client-id" \
  "GITHUB_CLIENT_SECRET=test-client-secret" \
  > .env.test.local
chmod 600 .env.test.local
```

- The CI step declares `env: { TOKEN_KEY: ${{ secrets.TEST_TOKEN_ENCRYPTION_KEY_V1 }} }` so the secret is masked but never written to a shell heredoc (which would be visible in the expanded command). `chmod 600` prevents other steps from reading it via artifact or globbing.
- `GITHUB_CLIENT_*` are stub strings because e2e sign-in uses Supabase Auth's local provider mock (§19.3), not real OAuth.

Vitest's `globalSetup` (§19.4) loads `.env.test.local` before any test file runs.

### 15.4 Full workflow YAML

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

# Split concurrency: cancel stale PR runs but never cancel a main deploy mid-flight.
# A canceled `vercel deploy --prebuilt` may leave prod in a partial state.
concurrency:
  group: ${{ github.ref == 'refs/heads/main' && 'deploy-main' || format('ci-{0}', github.ref) }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

env:
  PNPM_VERSION: "9.12.0"
  NODE_VERSION: "22"

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile

  lint:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: "${{ env.PNPM_VERSION }}" }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  lint-neg:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: "${{ env.PNPM_VERSION }}" }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint:neg

  typecheck:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: "${{ env.PNPM_VERSION }}" }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  unit:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: "${{ env.PNPM_VERSION }}" }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit

  db-integration:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: "${{ env.PNPM_VERSION }}" }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - name: Restore Supabase Docker image cache
        id: docker-cache
        uses: actions/cache@v4
        with:
          path: /tmp/supabase-images.tar.gz
          key: docker-supabase-${{ hashFiles('supabase/config.toml') }}
      - name: Load cached Docker images
        if: steps.docker-cache.outputs.cache-hit == 'true'
        run: gunzip -c /tmp/supabase-images.tar.gz | docker load
      - name: Start Supabase stack
        run: supabase start
      - name: Save Docker images to cache (first run only)
        if: steps.docker-cache.outputs.cache-hit != 'true'
        run: docker save $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>') | gzip > /tmp/supabase-images.tar.gz
      - name: Populate .env.test.local
        env:
          TOKEN_KEY: ${{ secrets.TEST_TOKEN_ENCRYPTION_KEY_V1 }}
        run: |
          set -euo pipefail
          SRK=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY')
          ANON=$(supabase status -o json | jq -r '.ANON_KEY')
          URL=$(supabase status -o json | jq -r '.API_URL')
          printf '%s\n' \
            "NEXT_PUBLIC_SUPABASE_URL=$URL" \
            "NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON" \
            "SUPABASE_SERVICE_ROLE_KEY=$SRK" \
            "TOKEN_ENCRYPTION_KEY_V1=$TOKEN_KEY" \
            "GITHUB_CLIENT_ID=test-client-id" \
            "GITHUB_CLIENT_SECRET=test-client-secret" \
            > .env.test.local
          chmod 600 .env.test.local
      - name: Reset database (replays all migrations)
        run: supabase db reset --no-seed
      - name: Generate and diff database types
        run: |
          set -euo pipefail
          pnpm exec supabase gen types typescript --local > /tmp/database.types.ts
          [ -s /tmp/database.types.ts ] || { echo "Generated types file is empty"; exit 1; }
          diff /tmp/database.types.ts lib/db/database.types.ts
      - name: Run integration tests
        run: pnpm test:integration
      - if: always()
        run: supabase stop

  e2e:
    needs: [setup, db-integration]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: "${{ env.PNPM_VERSION }}" }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: supabase/setup-cli@v1
      - run: supabase start
      - name: Populate .env.local
        env:
          TOKEN_KEY: ${{ secrets.TEST_TOKEN_ENCRYPTION_KEY_V1 }}
        run: |
          set -euo pipefail
          SRK=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY')
          ANON=$(supabase status -o json | jq -r '.ANON_KEY')
          URL=$(supabase status -o json | jq -r '.API_URL')
          printf '%s\n' \
            "NEXT_PUBLIC_SUPABASE_URL=$URL" \
            "NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON" \
            "SUPABASE_SERVICE_ROLE_KEY=$SRK" \
            "TOKEN_ENCRYPTION_KEY_V1=$TOKEN_KEY" \
            "GITHUB_CLIENT_ID=test-client-id" \
            "GITHUB_CLIENT_SECRET=test-client-secret" \
            > .env.local
          chmod 600 .env.local
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm build
      - name: Start app server in background
        run: |
          pnpm start > /tmp/next-server.log 2>&1 &
          echo "SERVER_PID=$!" >> "$GITHUB_ENV"
      - name: Wait for server ready
        run: |
          kill -0 $SERVER_PID || { cat /tmp/next-server.log; exit 1; }
          npx wait-on http://localhost:3000 --timeout 120000
      - run: pnpm test:e2e
      - name: Cleanup
        if: always()
        run: |
          kill $SERVER_PID || true
          supabase stop

  # Production deploy is TAG-TRIGGERED, not auto-promoted on every main push.
  # This gives the operator a gate to run the manual migration workflow first.
  # See db-migrate-prod.yml below.
  deploy:
    needs: [lint, lint-neg, typecheck, unit, db-integration, e2e]
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g vercel@latest
      # Use a project-scoped Vercel token (not a personal account token)
      # to limit blast radius — leaked token can only affect this project.
      - run: vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
      - run: vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
      - run: vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

### 15.5 GitHub Actions secrets

| Secret | Used by | Source |
| --- | --- | --- |
| `TEST_TOKEN_ENCRYPTION_KEY_V1` | `db-integration`, `e2e` | One-time `openssl rand -base64 32`, stored in repo secrets. Dedicated for tests — **do not** reuse the dev/prod key. |
| `VERCEL_TOKEN` | `deploy` | Vercel dashboard → Account Settings → Tokens |

`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are auto-resolved via `vercel pull` using `.vercel/project.json` committed after the initial `vercel link`. No production Supabase or GitHub OAuth secrets are needed in GitHub Actions — all tests use the local stack, and `vercel deploy --prebuilt` pulls production runtime secrets from Vercel itself.

**Token scope note.** `VERCEL_TOKEN` should be a **project-scoped** token (Vercel Teams plan) or issued from a dedicated deploy-bot account with minimum role. An account-scoped personal token carries full team permissions — if leaked, an attacker can deploy to or read env from every project in every team the token owner belongs to.

### 15.6a Production migration workflow — `db-migrate-prod.yml`

Production deploys are tag-triggered (§15.4 `deploy` job: `if: startsWith(github.ref, 'refs/tags/v')`). Before tagging a release, the operator runs this manual workflow to apply pending migrations to the production Supabase project. This is the **only** mechanism that touches the production database schema.

**Forward-fix-only constraint.** `supabase db push` applies migrations forward; there is no `supabase db rollback`. If a bad migration reaches production, the fix is a new corrective migration, not a revert. Before tagging, the operator should verify the migration locally via `supabase db reset` and on the dev cloud project. PITR (Point-in-Time Recovery, Supabase Pro plan) provides a last-resort rollback for catastrophic schema damage.

```yaml
# .github/workflows/db-migrate-prod.yml
name: DB Migrate Production

on:
  workflow_dispatch:
    inputs:
      confirm:
        description: "Type 'MIGRATE' to confirm production migration"
        required: true

jobs:
  migrate:
    if: inputs.confirm == 'MIGRATE'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      # Uses --db-url to avoid mutating supabase/.temp/project-ref (D9 fix)
      - name: Push migrations to production
        env:
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_PROD_DB_PASSWORD }}
        run: |
          supabase db push \
            --db-url "postgresql://postgres.${SUPABASE_PROD_PROJECT_REF}:${SUPABASE_DB_PASSWORD}@aws-0-${SUPABASE_PROD_REGION}.pooler.supabase.com:6543/postgres"
```

**Additional secrets for this workflow:**

| Secret | Purpose |
| --- | --- |
| `SUPABASE_PROD_DB_PASSWORD` | Production DB password (from Supabase dashboard → Project Settings → Database) |
| `SUPABASE_PROD_PROJECT_REF` | Production project ref (e.g., `abcdefghij`) |
| `SUPABASE_PROD_REGION` | Production region code (e.g., `ap-northeast-1`) |

### 15.6 `package.json` scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "biome check && eslint . --ignore-pattern '**/__fixtures__/**' && depcruise -c dependency-cruiser.cjs --exclude '__fixtures__' src/ lib/ app/",
    "lint:neg:depcruise": "! depcruise -c dependency-cruiser.cjs lib/pipeline/__fixtures__/bad-pipeline-import.ts 2>/dev/null",
    "lint:neg:eslint": "! eslint lib/__fixtures__/bad-process-env.ts 2>/dev/null",
    "lint:neg": "pnpm lint:neg:depcruise && pnpm lint:neg:eslint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run tests/unit tests/integration",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "db:reset": "supabase db reset",
    "db:types": "supabase gen types typescript --local > lib/db/database.types.ts"
  }
}
```

---

## 15a. Storage bucket provisioning — dashboard fallback

Primary path: migration `000012_storage_buckets_and_policies.sql` (§6.3) creates both buckets declaratively. `supabase db reset` applies them idempotently in every environment.

**Fallback** (use only if the migration somehow fails on a fresh cloud project):

1. Supabase dashboard → **Storage** → **New bucket** → `repo-assets`, public.
2. Same for `review-assets`.
3. Re-run migrations: `supabase db push`.

The RLS policies on `storage.objects` come from the migration regardless of how the buckets were created, so dashboard-created buckets still get policy-enforced paths.

---

## 16. GitHub OAuth app registration

Two OAuth Apps, one per environment. Register at https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**.

| App | Homepage URL | Authorization callback URL(s) |
| --- | --- | --- |
| `vibeshelf-dev` | `http://localhost:3000` | `http://localhost:3000/auth/callback`, `https://*-vibeshelf.vercel.app/auth/callback`, `https://<dev-supabase-ref>.supabase.co/auth/v1/callback` |
| `vibeshelf-prod` | `https://vibeshelf.app` | `https://vibeshelf.app/auth/callback`, `https://<prod-supabase-ref>.supabase.co/auth/v1/callback` |

**Scope:** `public_repo` only. Enough to fork a public repository on the user's behalf. `repo` (full private access) would alarm users and is not needed for MVP.

**Steps per app:**

1. Sign in as the admin GitHub account.
2. **Settings → Developer settings → OAuth Apps → New OAuth App**.
3. Fill in the table fields above.
4. Click **Register application**.
5. Copy the **Client ID** → becomes `GITHUB_CLIENT_ID`.
6. Click **Generate a new client secret** → copy immediately (shown once) → becomes `GITHUB_CLIENT_SECRET`.
7. Both values go into (a) Supabase Auth provider config (§17 Step 3) and (b) Vercel env (§17 Step 6).

**Notes:**

- The Supabase callback URL (`.../auth/v1/callback`) is required because Supabase Auth is the first-hop OAuth handler. It fetches the `code` from GitHub, then redirects to our `/auth/callback` route with the session established.
- Wildcard `*-vibeshelf.vercel.app` catches all Vercel preview deployments without manual per-branch registration. GitHub has allowed host-portion wildcards in OAuth callback URLs since 2023.

---

## 17. Infrastructure provisioning (ordered sequence)

Each step depends on the previous. This is the "human with hands on a keyboard" bootstrap.

### Step 1 — Create two Supabase projects

1. Log into https://supabase.com/dashboard.
2. **New project** → name `vibeshelf-dev`, pick the region closest to the primary developer. Free tier is fine for MVP.
3. Repeat for `vibeshelf-prod`, region closest to target users.
4. From each project's **Project Settings → API**, record:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret key** → `SUPABASE_SERVICE_ROLE_KEY`
5. From **Project Settings → General**, record the **Project Ref** — used by `supabase link --project-ref`.

### Step 2 — Register two GitHub OAuth apps

See §16. Record client ID + secret for each.

### Step 3 — Configure Supabase Auth GitHub provider

In each Supabase project (dev + prod):

1. **Authentication → Providers → GitHub**.
2. Toggle **Enabled**.
3. Paste the matching environment's `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
4. Note the callback URL Supabase displays: `https://<project-ref>.supabase.co/auth/v1/callback`. Copy it.
5. **Save**.
6. In the matching GitHub OAuth App (§16), add the Supabase callback URL as an additional authorized callback URL.

### Step 4 — Generate the token encryption key

One-time, per environment:

```bash
openssl rand -base64 32
```

- Save the output as `TOKEN_ENCRYPTION_KEY_V1` in a password manager or secure note.
- **Do NOT commit to any file.** Not even `.env.example`.
- Use a **different** value for dev and prod. If they share, a dev leak compromises prod.

### Step 5 — Create two Vercel projects

```bash
vercel login
cd vibeshelf

# Link the dev project (creates .vercel/project.json, commit it)
vercel link --yes --project vibeshelf-dev
```

Prod is linked in a separate clone or by temporarily switching the linked project before deploys. For MVP, a single developer machine per environment is fine.

### Step 6 — Populate Vercel environment variables

Per project:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL development preview production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY development preview production
vercel env add SUPABASE_SERVICE_ROLE_KEY development preview production --sensitive
vercel env add TOKEN_ENCRYPTION_KEY_V1 development preview production --sensitive
vercel env add GITHUB_CLIENT_ID development preview production
vercel env add GITHUB_CLIENT_SECRET development preview production --sensitive
```

Paste values when prompted. `--sensitive` marks secrets as encrypted (not shown in logs).

Pull locally:

```bash
vercel env pull .env.local --yes
```

Repeat Step 6 for the prod Vercel project with its corresponding prod secrets.

### Step 7 — `.env.example` template (committed)

```bash
# .env.example
# Copy to .env.local and populate via `vercel env pull .env.local` — do not edit by hand.
# See lib/env.ts for the authoritative zod schema.

NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TOKEN_ENCRYPTION_KEY_V1=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Reserved for sub-projects — safe to omit during Foundation:
# GEMINI_API_KEY=
```

### Step 8 — Env key diff check

After `vercel env pull`, verify every key in `.env.example` is present in `.env.local`:

```bash
template_file=.env.example
comm -23 \
  <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$template_file" | cut -d '=' -f 1 | sort -u) \
  <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.local | cut -d '=' -f 1 | sort -u)
```

Non-empty output = missing keys. Block bootstrap if non-empty.

### Step 9 — Link the Supabase CLI to the dev project and push migrations

```bash
supabase link --project-ref <dev-project-ref>
supabase db push
```

Applies `000001` through `000012` to `vibeshelf-dev`. On a fresh project, ~30 seconds.

For production, **do not** use `supabase link` switching — a forgotten switch-back means the next `supabase db reset` wipes prod instead of dev. Instead, use the stateless `--db-url` flag or the `db-migrate-prod.yml` GitHub Actions workflow (§15.6a):

```bash
# Stateless push to prod (never mutates supabase/.temp/project-ref)
supabase db push \
  --db-url "postgresql://postgres.<prod-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
```

Subsequent production migrations are handled by the manual `db-migrate-prod.yml` workflow (§15.6a), which is triggered before tagging a release.

### Step 10 — Generate and commit the Database type file

```bash
supabase gen types typescript --linked > lib/db/database.types.ts
git add lib/db/database.types.ts
git commit -m "chore: add generated database types"
```

The CI `db-integration` job verifies this file stays in sync with the local stack's generated output via a `diff` check.

---

## 19. Testing strategy

### 19.1 Unit tests (`tests/unit/`)

Pure functions only. No network, no DB, no Supabase client instantiation. Target: <1s total.

Foundation-scoped unit tests:

- **`lib/env.ts`** — zod schema validation. Happy path + each failure case (missing required field, malformed URL, malformed base64 for `TOKEN_ENCRYPTION_KEY_V1`, accepts both standard base64 and base64url).
- **`lib/crypto/tokens.ts`** — 100 random-plaintext `encryptToken → decryptToken` round-trips; unknown key version throws; ciphertext tamper (flip one byte) causes `decryptToken` to throw on auth-tag verification.
- Any additional pure helpers added during Chunks A–C implementation.

### 19.2 Integration tests (`tests/integration/`)

Run against `supabase start` local stack. Vitest's `globalSetup` (§19.4) boots the stack once per test run, applies migrations via `supabase db reset`, and loads `.env.test.local`.

Foundation-scoped integration tests:

- **`tests/integration/rls/`** — RLS policy matrix, see §19a.
- **`tests/integration/security-definer/`** — all 6 SECURITY DEFINER functions, happy + failure paths:
  - `handle_new_user` fires on `auth.users` INSERT; raises on missing OAuth metadata.
  - `upsert_user_oauth_token` happy path; rejects anonymous (42501).
  - `get_my_oauth_token_encrypted` happy path; raises P0002 on no row or revoked row; rejects anonymous.
  - `record_fork_event` happy path; idempotent on re-call; rejects non-published repo; rejects null fork id/url.
  - `create_review_with_fork_check` happy path; rejects without fork_events row; rejects rating out of 1..5; rejects non-published repo.
  - `mark_oauth_token_revoked` happy path; idempotent; rejects anonymous.
- **`tests/integration/run-job.test.ts`** — echo job lifecycle: `pipeline_runs` row transitions `running → success` with `metrics = {echo_count: 1}` and no error fields set. Failure case: a job that throws; row transitions to `failed` with `error_message` populated and the error re-thrown.
- **`tests/integration/storage-triggers.test.ts`** — deleting a `review_assets` row via `reviews` cascade also deletes the `storage.objects` row for the same bucket+key (verifies the cleanup trigger from §6.3). Same for `repo_assets`.

### 19.3 E2E tests (`tests/e2e/`)

Playwright against `pnpm start` serving a freshly-built app backed by the local Supabase stack.

**Scope for Foundation: one test.** `tests/e2e/sign-in.spec.ts`:

1. Navigate to `/`.
2. Click "Sign in with GitHub".
3. Supabase Auth's local GitHub provider mock accepts a pre-seeded test user.
4. Wait for redirect to `/`.
5. Query the local Supabase via a service client helper: assert `select count(*) from user_profiles where github_username = '<test-user>'` returns 1.
6. Click "Sign out" and assert the session cleared.

**No fork, review, or Pro E2E tests in Foundation.** Those belong to sub-projects #5 and #6.

### 19.4 Test helpers

#### `tests/helpers/test-user.ts`

Creates a synthetic auth user (which fires the `handle_new_user` trigger and creates the `user_profiles` row) and returns a Supabase client authenticated as that user. Uses real Supabase Auth sessions — no manual JWT minting, no JWT secret extraction.

```ts
// tests/helpers/test-user.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { env } from "@/lib/env"
import type { Database } from "@/lib/db/database.types"

const TEST_PASSWORD = "test-password-safe-for-local-only"

export async function createTestUser(opts?: {
  githubId?: number
  githubUsername?: string
}): Promise<{
  userId: string
  client: SupabaseClient<Database>
}> {
  const admin = createServiceTestClient()
  const email = `test-${crypto.randomUUID()}@example.test`
  const githubId = opts?.githubId ?? Math.floor(Math.random() * 1e9)
  const githubUsername = opts?.githubUsername ?? `test-${githubId}`

  // 1. Admin creates the user. handle_new_user trigger fires, creating user_profiles.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: {
      user_name: githubUsername,
      provider_id: String(githubId),
      avatar_url: `https://avatars.githubusercontent.com/u/${githubId}`,
      name: `Test User ${githubId}`,
    },
  })
  if (createErr || !created.user) throw createErr ?? new Error("createUser returned no user")

  // 2. Sign in as that user to obtain a real session (access_token).
  const authClient = createAnonTestClient()
  const { data: signedIn, error: signInErr } = await authClient.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  })
  if (signInErr || !signedIn.session) throw signInErr ?? new Error("sign-in returned no session")

  // 3. Return a client carrying the user JWT — auth.uid() resolves correctly in RLS.
  const client = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: {
        headers: { Authorization: `Bearer ${signedIn.session.access_token}` },
      },
      auth: { persistSession: false },
    },
  )

  return { userId: created.user.id, client }
}

export function createAnonTestClient(): SupabaseClient<Database> {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}

export function createServiceTestClient(): SupabaseClient<Database> {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}
```

#### Vitest `globalSetup`

```ts
// vitest.setup.ts
import { execSync } from "node:child_process"

export async function setup() {
  // Boot the local Supabase stack if not already running
  const status = execSync("supabase status -o json").toString()
  if (!status.includes("API URL")) {
    execSync("supabase start", { stdio: "inherit" })
  }

  // Reset the DB to a clean state (applies all migrations)
  execSync("supabase db reset --no-seed", { stdio: "inherit" })
}

export async function teardown() {
  // Leave the stack running for subsequent test runs.
  // CI tears it down via `supabase stop` in the job's `always()` step.
}
```

Vitest config references this file via `globalSetup: "./vitest.setup.ts"`.

---

## 19a. RLS policy test matrix

Every RLS policy in §5 and §6.3 gets at least one **allow** test and one **deny** test. Plus every SECURITY DEFINER function from §6 gets happy + failure path coverage.

### 19a.1 Table + storage policy tests

| Policy                                    | Allow test                                                      | Deny test                                                                             |
| ----------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `user_profiles_select_all`                | any user SELECTs any profile                                    | (public; no deny case)                                                                 |
| `user_profiles_update_own` + column grant | user updates own `display_name` / `avatar_url`                  | user updates another user's row; user updates own `github_id` → grant error            |
| `github_oauth_tokens` (deny-all)          | service role SELECTs                                            | authenticated SELECT returns empty                                                     |
| `github_tokens` (deny-all)                | service role SELECTs                                            | authenticated SELECT returns empty                                                     |
| `repos_select_published`                  | authenticated sees `status='published'` repo                    | authenticated does not see `status='pending'` or `'removed'` repo                      |
| `repo_scores_select_latest_published`     | authenticated sees latest score of published repo               | does not see `is_latest=false` row; does not see score of unpublished repo             |
| `tags_select_all`                         | authenticated sees all tags                                     | (public; no deny case)                                                                 |
| `repo_tags_select_published`              | authenticated sees tags on published repo                       | does not see tags on pending repo                                                      |
| `repo_assets_select_published`            | authenticated sees assets on published repo                     | does not see assets on pending repo                                                    |
| `fork_events_select_own`                  | user A SELECTs own fork_events                                  | user A does not see user B's fork_events                                               |
| `reviews_select_published`                | authenticated sees review on published repo                     | does not see review on removed repo                                                    |
| `reviews_update_own`                      | user updates own review text/rating                             | user tries to update another user's review                                             |
| `reviews_delete_own`                      | user deletes own review                                         | user tries to delete another user's review                                             |
| `review_assets_select_public`             | authenticated sees review asset on published repo               | does not see review asset on removed repo                                              |
| `review_assets_insert_own`                | (mirrors storage policy; see below)                             |                                                                                        |
| `review_assets_delete_own`                | (mirrors storage policy; see below)                             |                                                                                        |
| `pipeline_runs` (deny-all)                | service role SELECTs                                            | authenticated SELECT returns empty                                                     |
| storage `repo_assets_public_read`         | anon fetches `repo-assets/abc/kind/file.png`                    | (public; no deny)                                                                      |
| storage `review_assets_public_read`       | anon fetches `review-assets/uid/rid/0.png`                      | (public; no deny)                                                                      |
| storage `review_assets_owner_insert`      | owner uploads to `{owner_uid}/{owned_rid}/0.png`                | Deny inputs: (a) `{other_uid}/{rid}/0.png` (non-owner uid), (b) `{uid}/{non_owned_rid}/0.png` (review not owned), (c) `{uid}/0.png` (1-segment — missing review_id), (d) `{uid}/{rid}/extra/0.png` (3-level path), (e) `{uid}/{rid}/5.png` (ordering out of 0-4), (f) `{uid}/{rid}/0.svg` (disallowed extension), (g) `{uid}/{rid}/abc.png` (non-numeric filename prefix) |
| storage `review_assets_owner_delete`      | owner deletes own asset                                         | non-owner deletes                                                                      |

**~35 test cases** across tables + storage.

### 19a.2 SECURITY DEFINER function tests

| Function                           | Happy path                                                       | Failure cases                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `handle_new_user`                  | `admin.createUser` with full metadata → `user_profiles` row exists | `admin.createUser({..., user_metadata: {}})` → trigger `raise exception` → admin API returns error, no auth.users row created |
| `upsert_user_oauth_token`          | authenticated user calls RPC directly with a dummy encrypted token (bypasses OAuth callback — see note below) → row exists, `revoked_at = null` | anonymous (no session) → 42501                                                                                |
| `get_my_oauth_token_encrypted`     | authenticated with active token → returns 1 row                  | anonymous → 42501; no token for user → P0002; active revoked_at → P0002                                      |
| `record_fork_event`                | authenticated, published repo → row exists; re-call is idempotent | anonymous → 42501; unpublished repo → no_data_found; null fork id/url → invalid_parameter_value              |
| `create_review_with_fork_check`    | authenticated + prior fork → review row exists                   | anonymous → 42501; no fork_events row → 42501; rating 0 or 6 → check_violation; unpublished repo → no_data_found |
| `mark_oauth_token_revoked`         | authenticated with active token → `revoked_at` set; idempotent   | anonymous → 42501                                                                                             |

**~15 test cases** across 6 functions.

**Grand total: ~50 integration tests.** Fits comfortably in a <2-minute CI run against a warm Supabase local stack.

**Testing note on OAuth callback bypass.** The test helper `createTestUser` signs in via password, not GitHub OAuth. This means `session.provider_token` is `null` — tests cannot exercise the `upsert_user_oauth_token` RPC through the OAuth callback flow. Instead, tests call the RPC directly:

```ts
const dummyToken = encryptToken("ghp_test_token_for_rls", 1)
await userClient.rpc("upsert_user_oauth_token", {
  p_token_encrypted: dummyToken,
  p_token_key_version: 1,
  p_scopes: ["public_repo"],
})
```

This tests the SECURITY DEFINER function and RLS in isolation. The full OAuth callback flow (§10.4) is verified by the Playwright e2e test, which uses Supabase Auth's local GitHub provider mock and hits the actual callback route.

**P0002 collapse is intentional.** `get_my_oauth_token_encrypted` raises `P0002` for both "no token ever stored" and "token revoked". Both map to the same user-facing action: "re-authenticate". If a future sub-project needs to distinguish these states, the function can be split into two errcodes — but for Foundation, the collapse is simpler and correct.

---

## 20. Acceptance criteria (executable)

Each of the 6 success criteria from §1.3 maps to a concrete verification command or test case. Additional Foundation-internal checks (A7–A12) cover the work that §1.3 implies but doesn't name explicitly.

| # | Criterion | How it's verified |
| - | --------- | ----------------- |
| 1 | `pnpm install && pnpm build` succeeds on a fresh clone | CI `e2e` job runs `pnpm build` before Playwright; `deploy` job runs `vercel build --prod`. Both green = criterion met. |
| 2 | `supabase db reset --linked` applies all migrations cleanly | CI `db-integration` job runs `supabase db reset` against the local stack with the same migration files. Same guarantee as `--linked` because both consume `supabase/migrations/*.sql` identically. |
| 3 | CI passes on a trivial PR | All 7 CI jobs (setup, lint, lint-neg, typecheck, unit, db-integration, e2e) must be green. `deploy` runs only on `main`. |
| 4 | Manual GitHub sign-in on a preview URL creates a `user_profiles` row | Playwright `tests/e2e/sign-in.spec.ts` asserts `select count(*) from user_profiles where github_username = '<test-user>'` returns 1. |
| 5 | Dep-cruiser rejects `import { cookies } from 'next/headers'` inside `lib/pipeline/` | CI `lint-neg` job runs `pnpm lint:neg:depcruise` against `lib/pipeline/__fixtures__/bad-pipeline-import.ts`. Green only if dep-cruiser exits non-zero. |
| 6 | ESLint rejects `process.env.*` outside `lib/env.ts` | CI `lint-neg` job runs `pnpm lint:neg:eslint` against `lib/__fixtures__/bad-process-env.ts`. Green only if ESLint exits non-zero. |
| **A7** | RLS policy matrix passes 35+ allow/deny tests | `tests/integration/rls/` suite green. |
| **A8** | SECURITY DEFINER functions pass 15+ happy/failure tests | `tests/integration/security-definer/` suite green. |
| **A9** | Echo job `pipeline_runs` lifecycle round-trip passes | `tests/integration/run-job.test.ts` green. |
| **A10** | Storage cleanup trigger deletes underlying object on cascade | `tests/integration/storage-triggers.test.ts` green. |
| **A11** | `envScope` is a complete scope manifest for every `Env` key | `typecheck` job catches the `satisfies Record<keyof Env, ...>` constraint failure at compile time. |
| **A12** | Generated `database.types.ts` stays in sync with the migration file state | `db-integration` job runs `diff /tmp/database.types.ts lib/db/database.types.ts`. Non-zero diff = failing job. |

**When all 12 checks are green on `main`**, Foundation is **done** and sub-project #2 (ingestion pipeline) can begin.

---

## End of Chunk D

**Approval request:** Does Chunk D look right?

If **yes**, the next steps are:

1. **Inline self-review pass** (I re-read the whole spec for placeholders, contradictions, ambiguity, scope creep).
2. **User review gate** — you read the final spec and either approve OR flag revisions.
3. **Transition** — once approved, invoke `superpowers:writing-plans` to produce the implementation plan.

If **no**, specify what to revise. Common revision vectors: add or remove a CI job, adjust the caching strategy, change the provisioning sequence, tighten the test matrix, expand/narrow acceptance criteria.
