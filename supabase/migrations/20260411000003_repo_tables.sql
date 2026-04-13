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
