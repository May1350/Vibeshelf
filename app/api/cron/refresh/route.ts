import { env } from "@/lib/env";
import { refreshJob } from "@/lib/pipeline/jobs/refresh";
import { runJob } from "@/lib/pipeline/runJob";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-refresh", {}, (ctx) => refreshJob(ctx));
  return Response.json(result);
}
