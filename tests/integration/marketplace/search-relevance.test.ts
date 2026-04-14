// Integration tests for marketplace search relevance.
// The search_vector is GENERATED:
//   setweight(to_tsvector(name),       'A') ||
//   setweight(to_tsvector(description), 'B')
// So a query matching in the NAME should outrank the same query matching
// only in the description. The RPC doesn't currently sort by ts_rank — it
// falls back to 'score' / 'recent' / 'popular'. Still, both should appear
// in results, and the plainto_tsquery shouldn't crash on special chars.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { createServiceTestClient } from "@/tests/helpers/test-user";

const GH_ID_BASE = 900_800_000;
const GH_ID_TOP = 900_801_000;

// RPC types regen pending; cast-to-any for rpc() call shape.
let svc: SupabaseClient<Database> & { rpc: (name: string, args: any) => any };

async function cleanup(): Promise<void> {
  await svc.from("repos").delete().gte("github_id", GH_ID_BASE).lt("github_id", GH_ID_TOP);
}

async function seed(opts: {
  offset: number;
  owner: string;
  name: string;
  description?: string;
  scoreTotal?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: GH_ID_BASE + opts.offset,
      owner: opts.owner,
      name: opts.name,
      description: opts.description ?? null,
      license: "MIT",
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status: "published",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("insert failed");
  const base = opts.scoreTotal ?? 4;
  // database.types.ts stale — matches lib/marketplace cast-to-any convention.
  const svcAny = svc as any;
  await svcAny.from("repo_scores").insert({
    repo_id: data.id,
    documentation_score: base,
    maintenance_score: base,
    popularity_score: base,
    code_health_score: base,
    visual_preview_score: base,
    scoring_model: "fixture",
    scoring_prompt_version: "1.0.0",
    is_latest: true,
    evidence_strength: "strong",
  });
}

beforeAll(async () => {
  svc = createServiceTestClient() as SupabaseClient<Database> & {
    rpc: (name: string, args: any) => any;
  };
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("search weighting and safety", () => {
  it("repo with query term in name (weight A) is returned alongside description-match (weight B)", async () => {
    // Both repos have equal axis scores, so sort=score is a tie — we just
    // verify both match and that the set contains the name-match row.
    await seed({
      offset: 1,
      owner: "sr-a",
      name: "authportal",
      description: "unrelated marketing copy",
    });
    await seed({
      offset: 2,
      owner: "sr-a",
      name: "some-other-repo",
      description: "handles authportal flows inside the app",
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: "authportal",
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string }>;
    const mine = rows.filter((r) => r.owner === "sr-a");
    expect(mine.some((r) => r.name === "authportal")).toBe(true);
    expect(mine.some((r) => r.name === "some-other-repo")).toBe(true);
  });

  it("plainto_tsquery is safe with punctuation / special characters", async () => {
    await seed({
      offset: 10,
      owner: "sr-b",
      name: "boring-template",
      description: "no special query would hit this",
    });

    // Each of these should NOT throw — plainto_tsquery normalises punctuation.
    const queries = ["foo!@#$", "'; DROP TABLE", "multi word query", "hyphen-word"];
    for (const q of queries) {
      const { error } = await svc.rpc("list_repos_no_tags", {
        p_q: q,
        p_categories: null,
        p_min_score: null,
        p_vibecoding: null,
        p_sort: "score",
        p_offset: 0,
      });
      expect(error).toBeNull();
    }
  });

  it("empty result set does not error", async () => {
    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: "zzzznomatchzzzzxxxxyyyy",
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data ?? []).length).toBe(0);
  });
});
