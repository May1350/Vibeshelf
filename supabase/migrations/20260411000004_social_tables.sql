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
