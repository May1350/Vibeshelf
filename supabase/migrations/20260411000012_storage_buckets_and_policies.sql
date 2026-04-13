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
