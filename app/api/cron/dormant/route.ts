import { env } from "@/lib/env";
import { dormantJob } from "@/lib/pipeline/jobs/dormant";
import { runJob } from "@/lib/pipeline/runJob";

// Node runtime is the default in Next 16; an explicit `runtime` export
// is incompatible with `cacheComponents`.
// Dormant is a single SQL UPDATE — 60s is ample even on Hobby.
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-dormant", {}, (ctx) => dormantJob(ctx));
  return Response.json(result);
}
