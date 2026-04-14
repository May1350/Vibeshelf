-- Child runs (those with parent_run_id set) MUST carry repo_id in input
-- for per-repo traceability (see spec §6.2 — operator queries).
--
-- NOT VALID avoids checking existing rows: Foundation's run-job.test.ts
-- echo job spawned child runs without repo_id in input. Those rows are
-- historical and shouldn't break the migration. New inserts/updates still
-- enforce the constraint.
ALTER TABLE public.pipeline_runs
  ADD CONSTRAINT pipeline_runs_child_has_repo_id
    CHECK (parent_run_id IS NULL OR input ? 'repo_id')
    NOT VALID;
