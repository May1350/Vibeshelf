import { revalidateTag } from "next/cache";
import { env } from "@/lib/env";
import { scoreJob } from "@/lib/pipeline/jobs/score";
import { runJob } from "@/lib/pipeline/runJob";

// Node runtime needed — GeminiClient uses @google/genai (Node SDK),
// and lib/crypto/tokens uses node:crypto for the GitHub token pool.
// Node runtime is the default in Next 16; an explicit `runtime` export
// is incompatible with `cacheComponents`.

// Pro 300s budget. On Hobby Vercel silently caps at 60s; internal budget
// won't fire (function is killed first). Acceptable trade-off for MVP —
// we'll be on Pro before production scoring volume is real.
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runJob("ingest-score", {}, (ctx) => scoreJob(ctx));

  // Invalidate cache tags for changed repos. Pipeline jobs cannot import
  // next/cache (Foundation rule 9), so they surface IDs and the route
  // handles invalidation. revalidateTag(tag, profile) form is required
  // in Next 16 (single-arg overload deprecated, Critical R1.C1).
  const ids = result.changedRepoIds ?? [];
  if (ids.length > 0) {
    revalidateTag("repos:facets", "max");
    revalidateTag("repos:list", "max");
    for (const id of ids) revalidateTag(`repo:${id}`, "max");
  }

  return Response.json(result);
}
