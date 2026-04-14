// Seed local Supabase with 30 fixture repos for marketplace UI development.
// Refuses to run in production or against non-localhost URLs.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (process.env.NODE_ENV === "production") {
  console.error("[seed-dev] Refusing to run in production.");
  process.exit(1);
}
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error(`[seed-dev] Refusing — NEXT_PUBLIC_SUPABASE_URL is not localhost: ${url}`);
  process.exit(1);
}

const FIXTURE_REPOS = Array.from({ length: 30 }, (_, i) => {
  const id = i + 1;
  return {
    github_id: 800_000_000 + id,
    owner: `fixture-${String(id).padStart(2, "0")}`,
    name: `template-${id}`,
    description: `Fixture template #${id} — for local marketplace UI development.`,
    license: "mit",
    default_branch: "main",
    stars: Math.floor(Math.random() * 5000),
    forks: Math.floor(Math.random() * 500),
    watchers: Math.floor(Math.random() * 100),
    last_commit_at: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
    github_created_at: new Date(
      Date.now() - Math.random() * 730 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    github_pushed_at: new Date(
      Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    status: "published" as const,
    category: ["saas", "ecommerce", "dashboard", "landing_page", "ai_tool", "blog", "portfolio"][
      i % 7
    ] as "saas" | "ecommerce" | "dashboard" | "landing_page" | "ai_tool" | "blog" | "portfolio",
  };
});

async function main(): Promise<void> {
  const db = createClient(url, serviceRole, { auth: { persistSession: false } });

  const { data: insertedRepos, error: reposErr } = await db
    .from("repos")
    .upsert(FIXTURE_REPOS, { onConflict: "github_id" })
    .select("id, github_id");
  if (reposErr) throw new Error(`repos upsert: ${reposErr.message}`);

  const scoreRows = (insertedRepos ?? []).map((r) => ({
    repo_id: r.id,
    documentation_score: 3 + Math.random() * 2,
    maintenance_score: 3 + Math.random() * 2,
    popularity_score: 3 + Math.random() * 2,
    code_health_score: 3 + Math.random() * 2,
    visual_preview_score: 3 + Math.random() * 2,
    scoring_model: "fixture",
    scoring_prompt_version: "1.0.0",
    is_latest: true,
    evidence_strength: "strong" as const,
  }));
  // Wipe prior latest before insert (simple seed pattern; real RPC handles this atomically)
  if (insertedRepos && insertedRepos.length > 0) {
    await db
      .from("repo_scores")
      .delete()
      .in(
        "repo_id",
        insertedRepos.map((r) => r.id),
      );
  }
  const { error: scoresErr } = await db.from("repo_scores").insert(scoreRows);
  if (scoresErr) throw new Error(`repo_scores insert: ${scoresErr.message}`);

  console.log(`[seed-dev] Inserted ${insertedRepos?.length ?? 0} repos + scores.`);
  console.log(`[seed-dev] Visit http://localhost:3000`);
}

main().catch((err) => {
  console.error("[seed-dev] Failed:", err);
  process.exit(1);
});
