// Integration tests for get_marketplace_facets RPC.
// Covers:
//   * Counts only status='published' repos.
//   * All 4 facet types present: category / tag / vibecoding / score_bucket.
//   * 0-result safety: returns '{}' not error.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { createServiceTestClient } from "@/tests/helpers/test-user";

const GH_ID_BASE = 900_600_000;
const GH_ID_TOP = 900_601_000;

// RPC types regen pending; cast-to-any for rpc() call shape.
let svc: SupabaseClient<Database> & { rpc: (name: string, args?: any) => any };

async function cleanup(): Promise<void> {
  await svc.from("repos").delete().gte("github_id", GH_ID_BASE).lt("github_id", GH_ID_TOP);
}

async function seedPublished(opts: {
  offset: number;
  category?: Database["public"]["Enums"]["repo_category"];
  status?: Database["public"]["Enums"]["repo_status"];
  featureTags?: readonly string[];
  vibecodingTags?: readonly string[];
  scores?: {
    documentation: number;
    maintenance: number;
    popularity: number;
    code_health: number;
    visual_preview: number;
  };
}): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: GH_ID_BASE + opts.offset,
      owner: `fct-${opts.offset}`,
      name: `repo-${opts.offset}`,
      license: "MIT",
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status: opts.status ?? "published",
      category: opts.category ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("insert failed");

  if (opts.scores) {
    // database.types.ts stale — matches lib/marketplace cast-to-any convention.
    const svcAny = svc as any;
    await svcAny.from("repo_scores").insert({
      repo_id: data.id,
      documentation_score: opts.scores.documentation,
      maintenance_score: opts.scores.maintenance,
      popularity_score: opts.scores.popularity,
      code_health_score: opts.scores.code_health,
      visual_preview_score: opts.scores.visual_preview,
      scoring_model: "fixture",
      scoring_prompt_version: "1.0.0",
      is_latest: true,
      evidence_strength: "strong",
    });
  }

  const allTagSlugs = [...(opts.featureTags ?? []), ...(opts.vibecodingTags ?? [])];
  if (allTagSlugs.length > 0) {
    const { data: tagRows } = await svc.from("tags").select("id, slug").in("slug", allTagSlugs);
    const linkRows = (tagRows ?? []).map((t) => ({
      repo_id: data.id,
      tag_id: t.id,
      source: "ai" as const,
      confidence: 0.9,
    }));
    if (linkRows.length > 0) {
      await svc.from("repo_tags").insert(linkRows);
    }
  }
  return { id: data.id };
}

async function ensureVibecodingTag(slug: string): Promise<void> {
  const { data } = await svc.from("tags").select("id").eq("slug", slug).maybeSingle();
  if (!data) {
    await svc.from("tags").insert({ slug, kind: "vibecoding_tool", label: slug });
  }
}

beforeAll(async () => {
  svc = createServiceTestClient() as SupabaseClient<Database> & {
    rpc: (name: string, args?: any) => any;
  };
  await cleanup();
  await ensureVibecodingTag("cursor");
});

afterAll(async () => {
  await cleanup();
});

describe("get_marketplace_facets", () => {
  it("returns all 4 facet sections (category/tag/vibecoding/score_bucket)", async () => {
    await seedPublished({
      offset: 1,
      category: "saas",
      featureTags: ["auth"],
      vibecodingTags: ["cursor"],
      scores: {
        documentation: 5,
        maintenance: 5,
        popularity: 5,
        code_health: 5,
        visual_preview: 5,
      },
    });

    const { data, error } = await svc.rpc("get_marketplace_facets");
    expect(error).toBeNull();
    // The RPC returns '{}'::jsonb if there are ZERO facets in the system,
    // but typically each of the 4 cte branches contributes its key.
    const facets = (data ?? {}) as Record<string, Record<string, number>>;
    // At least one category bucket, including 'saas'
    expect(facets.category?.saas).toBeGreaterThanOrEqual(1);
    expect(facets.tag?.auth).toBeGreaterThanOrEqual(1);
    expect(facets.vibecoding?.cursor).toBeGreaterThanOrEqual(1);
    expect(facets.score_bucket?.min_3).toBeGreaterThanOrEqual(1);
    expect(facets.score_bucket?.min_4).toBeGreaterThanOrEqual(1);
    expect(facets.score_bucket?.min_4_5).toBeGreaterThanOrEqual(1);
  });

  it("pending (non-published) repos are NOT counted", async () => {
    await seedPublished({
      offset: 10,
      // "portfolio" added in 20260415000005; types stale.
      category: "portfolio" as any,
      status: "pending",
      scores: {
        documentation: 5,
        maintenance: 5,
        popularity: 5,
        code_health: 5,
        visual_preview: 5,
      },
    });

    const { data } = await svc.rpc("get_marketplace_facets");
    const facets = (data ?? {}) as Record<string, Record<string, number>>;
    // "portfolio" count, if present, must NOT include our pending row. Because
    // cleanup() runs before this, only our seed contributes "portfolio" in
    // this test range. So either (a) no portfolio key or (b) non-positive.
    const count = facets.category?.portfolio ?? 0;
    expect(count).toBe(0);
  });

  it("0-result-safe: returns an object (never throws) when no published repos match the facet kind", async () => {
    const { data, error } = await svc.rpc("get_marketplace_facets");
    expect(error).toBeNull();
    expect(typeof data).toBe("object");
  });
});
