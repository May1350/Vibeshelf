-- ══════════════════════════════════════════════════════════════════════
-- Migration: extend repo_tags.source CHECK to include 'auto'
--
-- Context: The ingestion pipeline (sub-project #2) writes tags derived
-- from package.json parsing and file-tree inspection — these are
-- deterministic extractor outputs, distinct from AI inference ('ai'),
-- human curation ('manual'), and aggregated review signals
-- ('review_derived'). Introducing 'auto' lets us track provenance and
-- (later) weight confidence differently per source.
--
-- Postgres cannot ALTER a CHECK constraint in place — the only supported
-- path is DROP + ADD. We use IF EXISTS on the DROP so this migration is
-- idempotent against a DB that was created from a later schema dump.
--
-- The original constraint name (`repo_tags_source_check`) follows
-- Postgres's default auto-naming convention: `<table>_<column>_check`.
-- Migration 20260411000003 declared the CHECK inline on the column, so
-- the constraint name is deterministic. If a future hand-written
-- constraint renames it, this migration will need to be updated.
-- ══════════════════════════════════════════════════════════════════════

alter table public.repo_tags
  drop constraint if exists repo_tags_source_check;

alter table public.repo_tags
  add constraint repo_tags_source_check
  check (source in ('ai', 'manual', 'review_derived', 'auto'));
