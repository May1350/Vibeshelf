import { env } from "@/lib/env";
import { pruneJob } from "@/lib/pipeline/jobs/prune";
import { runJob } from "@/lib/pipeline/runJob";

export const runtime = "nodejs";
// Prune is a single DELETE statement — 60s is ample even on Hobby.
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("pipeline-prune", {}, (ctx) => pruneJob(ctx));
  return Response.json(result);
}
