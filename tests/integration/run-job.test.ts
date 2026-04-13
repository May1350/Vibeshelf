import { describe, it, expect, beforeAll } from "vitest";
import { runJob } from "@/lib/pipeline/runJob";
import { createServiceTestClient } from "@/tests/helpers/test-user";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";

let svc: SupabaseClient<Database>;

beforeAll(() => {
  svc = createServiceTestClient();
});

describe("runJob", () => {
  it("success path: pipeline_runs row transitions to status=success with metrics", async () => {
    const result = await runJob(
      "echo-test",
      { message: "hi" },
      async (ctx) => {
        ctx.metric("echo_count", 1);
        return { echo_count: 1 };
      },
    );

    expect(result).toEqual({ echo_count: 1 });

    // Find the pipeline_runs row
    const { data, error } = await svc
      .from("pipeline_runs")
      .select("*")
      .eq("job_name", "echo-test")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    expect(error).toBeNull();
    expect(data?.status).toBe("success");
    expect(data?.finished_at).not.toBeNull();
    expect(data?.error_message).toBeNull();
    expect(data?.metrics).toEqual({ echo_count: 1 });
  });

  it("failure path: pipeline_runs row transitions to status=failed with error_message", async () => {
    await expect(
      runJob(
        "fail-test",
        {},
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    // Find the pipeline_runs row
    const { data, error } = await svc
      .from("pipeline_runs")
      .select("*")
      .eq("job_name", "fail-test")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    expect(error).toBeNull();
    expect(data?.status).toBe("failed");
    expect(data?.finished_at).not.toBeNull();
    expect(data?.error_message).toBe("boom");
  });
});
