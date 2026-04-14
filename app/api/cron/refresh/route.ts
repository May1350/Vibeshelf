import { revalidateTag } from "next/cache";
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

  // Invalidate cache tags for changed repos. Pipeline jobs cannot import
  // next/cache (Foundation rule 9). revalidateTag(tag, profile) form is
  // required in Next 16 (single-arg overload deprecated, Critical R1.C1).
  const ids = result.changedRepoIds ?? [];
  if (ids.length > 0) {
    revalidateTag("repos:facets", "max");
    revalidateTag("repos:list", "max");
    for (const id of ids) revalidateTag(`repo:${id}`, "max");
  }

  return Response.json(result);
}
