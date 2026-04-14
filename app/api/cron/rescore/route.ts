import { env } from "@/lib/env";
import { rescoreJob } from "@/lib/pipeline/jobs/rescore";
import { runJob } from "@/lib/pipeline/runJob";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-rescore", {}, (ctx) => rescoreJob(ctx));
  return Response.json(result);
}
