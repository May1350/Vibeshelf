import { revalidateTag } from "next/cache";
import { env } from "@/lib/env";
import { discoverJob } from "@/lib/pipeline/jobs/discover";
import { runJob } from "@/lib/pipeline/runJob";

// Cron routes need the Node runtime — lib/crypto/tokens uses
// node:crypto (AES-256-GCM for the GitHub token pool) and the pipeline
// makes long-lived fetches that Edge's isolate model isn't suited for.
// Node runtime is the default in Next 16; an explicit `runtime` export
// is incompatible with `cacheComponents` (see next.config.ts).

// Hobby plan: 60s, Pro: 300s. We set 300 so Pro uses the full budget;
// on Hobby Vercel silently caps at 60s and the job's internal
// `timed_out` flag won't fire (the function is killed before
// refresh.ts can observe its own budget). Acceptable trade-off for
// MVP — we'll be on Pro before production cron volume is real.
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  // NOTE: `!==` comparison is vulnerable to a theoretical timing oracle.
  // Acceptable for MVP — the CRON_SECRET is 32 random bytes, Vercel's
  // network jitter dwarfs the timing signal, and the attacker payoff
  // (triggering a cron) is low. Upgrade to timingSafeEqual if we ever
  // expose this route to untrusted networks without Vercel in front.
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Contract: response body is DiscoverOutput (counts + lock_acquired).
  // DO NOT add sensitive data (tokens, raw errors, repo lists) to the
  // output type — cron runs show up in Vercel's function logs.
  const result = await runJob("ingest-discover", {}, (ctx) => discoverJob(ctx));

  // Invalidate cache tags for changed repos. revalidateTag(tag, profile)
  // form — single-arg overload deprecated in Next 16 (Critical R1.C1).
  // Pipeline jobs cannot import next/cache (Foundation rule 9), so they
  // surface IDs and the route handles invalidation.
  const ids = result.changedRepoIds ?? [];
  if (ids.length > 0) {
    revalidateTag("repos:facets", "max");
    revalidateTag("repos:list", "max");
    for (const id of ids) revalidateTag(`repo:${id}`, "max");
  }

  return Response.json(result);
}
