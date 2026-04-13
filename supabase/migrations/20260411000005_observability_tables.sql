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
