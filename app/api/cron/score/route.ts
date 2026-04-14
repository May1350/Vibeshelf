import { env } from "@/lib/env";
import { scoreJob } from "@/lib/pipeline/jobs/score";
import { runJob } from "@/lib/pipeline/runJob";

// Node runtime needed — GeminiClient uses @google/genai (Node SDK),
// and lib/crypto/tokens uses node:crypto for the GitHub token pool.
export const runtime = "nodejs";

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
  return Response.json(result);
}
