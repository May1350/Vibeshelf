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
