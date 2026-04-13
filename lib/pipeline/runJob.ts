import { createServiceClient } from "@/lib/db/service-client"
import { startSpan } from "./trace"
import type { JobInput, JobOutput, JobContext } from "@/lib/types/jobs"

export async function runJob<I extends JobInput, O extends JobOutput>(
  jobName: string,
  input: I,
  fn: (ctx: JobContext) => Promise<O>,
  options?: { parentRunId?: string },
): Promise<O> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceClient() as any
  const span = startSpan(`job:${jobName}`)
  const metrics: Record<string, number | string> = {}

  const { data: run, error: insertErr } = await db
    .from("pipeline_runs")
    .insert({
      job_name: jobName,
      trace_id: span.traceId,
      parent_run_id: options?.parentRunId ?? null,
      input: input as unknown as Record<string, unknown>,
      status: "running",
    })
    .select("id")
    .single()

  if (insertErr || !run) throw insertErr ?? new Error("Failed to create pipeline_runs row")

  const ctx: JobContext = {
    runId: run.id,
    parentRunId: options?.parentRunId ?? null,
    db,
    metric(name, value) {
      metrics[name] = value
    },
    async spawn(childName, childInput, childFn) {
      return runJob(childName, childInput, childFn, { parentRunId: run.id })
    },
  }

  try {
    const result = await fn(ctx)

    await db
      .from("pipeline_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        metrics,
      })
      .eq("id", run.id)

    span.end()
    return result
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    await db
      .from("pipeline_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: error.message,
        error_stack: error.stack,
        metrics,
      })
      .eq("id", run.id)

    span.recordException(err)
    span.end()
    throw err
  }
}
