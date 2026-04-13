import type { SupabaseClient } from "@supabase/supabase-js"

export type JobInput = Record<string, unknown>
export type JobOutput = Record<string, unknown>

export interface JobContext {
  readonly runId: string
  readonly parentRunId: string | null
  readonly db: SupabaseClient
  metric(name: string, value: number | string): void
  spawn<I extends JobInput, O extends JobOutput>(
    childJobName: string,
    childInput: I,
    childFn: (childCtx: JobContext) => Promise<O>,
  ): Promise<O>
}
