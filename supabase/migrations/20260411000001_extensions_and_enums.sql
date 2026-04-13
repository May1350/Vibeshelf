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
