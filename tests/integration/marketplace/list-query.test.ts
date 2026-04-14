// Integration tests for list_repos_no_tags / list_repos_with_tags RPCs.
// Covers: tag-routing decision, filter combinations, AND-tag semantics,
// sort orderings, pagination offsets.
//
// Seeding convention: we use a prefix-based github_id range
// (900_500_000..900_500_999) and clean up via DELETE within that range to
// avoid touching other test data. Call the list RPCs with p_categories as
// public.repo_category[] (nullable for "no filter").
//
// NOTE: `total_score` and `search_vector` on public.repos are GENERATED
// columns; never include them in inserts. `repo_scores.total_score` is
// GENERATED from the 5 axis scores.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { createServiceTestClient } from "@/tests/helpers/test-user";

const GH_ID_BASE = 900_500_000;
const GH_ID_TOP = 900_501_000;

// RPC types regen pending; cast-to-any for rpc() call shape.
let svc: SupabaseClient<Database> & { rpc: (name: string, args: any) => any };

async function cleanup(): Promise<void> {
  // Cascades through repo_scores / repo_tags / repo_assets via FK ON DELETE.
  await svc.from("repos").delete().gte("github_id", GH_ID_BASE).lt("github_id", GH_ID_TOP);
}

interface SeedRepoInput {
  readonly githubIdOffset: number;
  readonly owner: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: Database["public"]["Enums"]["repo_category"] | null;
  readonly status?: Database["public"]["Enums"]["repo_status"];
  readonly stars?: number;
  readonly forks?: number;
  readonly lastCommitAt?: string;
  readonly githubCreatedAt?: string;
  readonly scores?: {
    documentation: number;
    maintenance: number;
    popularity: number;
    code_health: number;
    visual_preview: number;
  };
  readonly featureTagSlugs?: readonly string[];
}

async function seedRepo(input: SeedRepoInput): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: GH_ID_BASE + input.githubIdOffset,
      owner: input.owner,
      name: input.name,
      description: input.description ?? null,
      license: "MIT",
      last_commit_at: input.lastCommitAt ?? now,
      github_created_at: input.githubCreatedAt ?? now,
      github_pushed_at: now,
      status: input.status ?? "published",
      category: input.category ?? null,
      stars: input.stars ?? 0,
      forks: input.forks ?? 0,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedRepo failed");

  if (input.scores) {
    // database.types.ts is stale (still lists vibecoding_compat_score,
    // no visual_preview_score / evidence_strength). Regen (pnpm db:types)
    // is blocked on cloud schema sync. Match lib/marketplace's cast-to-any
    // convention so tests compile against stale types.
    const svcAny = svc as any;
    const { error: scoreErr } = await svcAny.from("repo_scores").insert({
      repo_id: data.id,
      documentation_score: input.scores.documentation,
      maintenance_score: input.scores.maintenance,
      popularity_score: input.scores.popularity,
      code_health_score: input.scores.code_health,
      visual_preview_score: input.scores.visual_preview,
      scoring_model: "fixture",
      scoring_prompt_version: "1.0.0",
      is_latest: true,
      evidence_strength: "strong",
    });
    if (scoreErr) throw scoreErr;
  }

  if (input.featureTagSlugs && input.featureTagSlugs.length > 0) {
    const { data: tagRows, error: tagErr } = await svc
      .from("tags")
      .select("id, slug")
      .in("slug", input.featureTagSlugs as string[]);
    if (tagErr) throw tagErr;
    const linkRows = (tagRows ?? []).map((t) => ({
      repo_id: data.id,
      tag_id: t.id,
      source: "ai" as const,
      confidence: 0.9,
    }));
    if (linkRows.length > 0) {
      const { error: rtErr } = await svc.from("repo_tags").insert(linkRows);
      if (rtErr) throw rtErr;
    }
  }

  return { id: data.id };
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

describe("list_repos_* RPC routing (no_tags vs with_tags)", () => {
  it("list_repos_no_tags returns published repos (empty tags → route here)", async () => {
    await seedRepo({
      githubIdOffset: 1,
      owner: "lq-a",
      name: "r-1",
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string }>;
    expect(rows.some((r) => r.owner === "lq-a")).toBe(true);
  });

  it("list_repos_with_tags returns only repos having the requested feature tag", async () => {
    await seedRepo({
      githubIdOffset: 10,
      owner: "lq-b",
      name: "r-auth",
      featureTagSlugs: ["auth"],
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });
    await seedRepo({
      githubIdOffset: 11,
      owner: "lq-b",
      name: "r-plain",
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data, error } = await svc.rpc("list_repos_with_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
      p_tags: ["auth"],
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string }>;
    const names = rows.filter((r) => r.owner === "lq-b").map((r) => r.name);
    expect(names).toContain("r-auth");
    expect(names).not.toContain("r-plain");
  });
});

describe("list_repos filters (category, min_score, q)", () => {
  it("category filter (array OR) returns only repos in chosen categories", async () => {
    await seedRepo({
      githubIdOffset: 20,
      owner: "lq-c",
      name: "saas-1",
      category: "saas",
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });
    await seedRepo({
      githubIdOffset: 21,
      owner: "lq-c",
      name: "blog-1",
      // "blog" added in migration 20260415000005; database.types.ts stale.
      category: "blog" as any,
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: ["saas"],
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string; category: string }>;
    const mine = rows.filter((r) => r.owner === "lq-c");
    expect(mine.some((r) => r.name === "saas-1")).toBe(true);
    expect(mine.some((r) => r.name === "blog-1")).toBe(false);
  });

  it("min_score filter excludes repos below threshold", async () => {
    await seedRepo({
      githubIdOffset: 30,
      owner: "lq-d",
      name: "high",
      scores: {
        documentation: 5,
        maintenance: 5,
        popularity: 5,
        code_health: 5,
        visual_preview: 5,
      },
    });
    await seedRepo({
      githubIdOffset: 31,
      owner: "lq-d",
      name: "low",
      scores: {
        documentation: 1,
        maintenance: 1,
        popularity: 1,
        code_health: 1,
        visual_preview: 1,
      },
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: 4,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string }>;
    const mine = rows.filter((r) => r.owner === "lq-d");
    expect(mine.some((r) => r.name === "high")).toBe(true);
    expect(mine.some((r) => r.name === "low")).toBe(false);
  });

  it("full-text search (p_q) matches against name+description tsvector", async () => {
    await seedRepo({
      githubIdOffset: 40,
      owner: "lq-e",
      name: "stripe-checkout",
      description: "Stripe payments integration",
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: "stripe",
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string }>;
    expect(rows.some((r) => r.owner === "lq-e" && r.name === "stripe-checkout")).toBe(true);
  });
});

describe("list_repos_with_tags AND semantics", () => {
  it("requires ALL specified tags (AND) — repo with only one tag is excluded", async () => {
    await seedRepo({
      githubIdOffset: 50,
      owner: "lq-f",
      name: "both",
      featureTagSlugs: ["auth", "payments"],
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });
    await seedRepo({
      githubIdOffset: 51,
      owner: "lq-f",
      name: "only-auth",
      featureTagSlugs: ["auth"],
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data, error } = await svc.rpc("list_repos_with_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
      p_tags: ["auth", "payments"],
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string }>;
    const mine = rows.filter((r) => r.owner === "lq-f");
    expect(mine.some((r) => r.name === "both")).toBe(true);
    expect(mine.some((r) => r.name === "only-auth")).toBe(false);
  });
});

describe("list_repos_no_tags sort orderings", () => {
  it("'score' sort orders by total_score desc (highest first)", async () => {
    await seedRepo({
      githubIdOffset: 60,
      owner: "lq-g",
      name: "score-high",
      scores: {
        documentation: 5,
        maintenance: 5,
        popularity: 5,
        code_health: 5,
        visual_preview: 5,
      },
    });
    await seedRepo({
      githubIdOffset: 61,
      owner: "lq-g",
      name: "score-low",
      scores: {
        documentation: 3,
        maintenance: 3,
        popularity: 3,
        code_health: 3,
        visual_preview: 3,
      },
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string; total_score: number }>;
    const mine = rows.filter((r) => r.owner === "lq-g");
    const highIdx = mine.findIndex((r) => r.name === "score-high");
    const lowIdx = mine.findIndex((r) => r.name === "score-low");
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("'recent' sort orders by last_commit_at desc", async () => {
    const older = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();
    await seedRepo({
      githubIdOffset: 70,
      owner: "lq-h",
      name: "older",
      lastCommitAt: older,
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });
    await seedRepo({
      githubIdOffset: 71,
      owner: "lq-h",
      name: "newer",
      lastCommitAt: newer,
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data, error } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "recent",
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ owner: string; name: string }>;
    const mine = rows.filter((r) => r.owner === "lq-h");
    expect(mine.findIndex((r) => r.name === "newer")).toBeLessThan(
      mine.findIndex((r) => r.name === "older"),
    );
  });
});

describe("list_repos_no_tags pagination offset", () => {
  it("p_offset skips the first N rows (smoke test — offset=1 shifts window)", async () => {
    // Two sortable repos, score-distinct.
    await seedRepo({
      githubIdOffset: 80,
      owner: "lq-i",
      name: "top",
      scores: {
        documentation: 5,
        maintenance: 5,
        popularity: 5,
        code_health: 5,
        visual_preview: 5,
      },
    });
    await seedRepo({
      githubIdOffset: 81,
      owner: "lq-i",
      name: "second",
      scores: {
        documentation: 4,
        maintenance: 4,
        popularity: 4,
        code_health: 4,
        visual_preview: 4,
      },
    });

    const { data: page0 } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 0,
    });
    const { data: page1 } = await svc.rpc("list_repos_no_tags", {
      p_q: null,
      p_categories: null,
      p_min_score: null,
      p_vibecoding: null,
      p_sort: "score",
      p_offset: 1,
    });
    const r0 = ((page0 ?? []) as Array<{ owner: string; name: string }>).filter(
      (r) => r.owner === "lq-i",
    );
    const r1 = ((page1 ?? []) as Array<{ owner: string; name: string }>).filter(
      (r) => r.owner === "lq-i",
    );
    // offset shifted past "top"
    expect(r0[0]?.name).toBe("top");
    expect(r1[0]?.name).not.toBe("top");
  });
});

describe("list_repos_*_count total rows", () => {
  it("list_repos_no_tags_count returns the same row count as list_repos_no_tags under identical filters", async () => {
    await seedRepo({
      githubIdOffset: 90,
      owner: "lq-j",
      name: "count-only",
      scores: {
        documentation: 4.5,
        maintenance: 4.5,
        popularity: 4.5,
        code_health: 4.5,
        visual_preview: 4.5,
      },
    });
    const { data: countData, error: countErr } = await svc.rpc("list_repos_no_tags_count", {
      p_q: null,
      p_categories: null,
      p_min_score: 4,
      p_vibecoding: null,
    });
    expect(countErr).toBeNull();
    expect(typeof countData).toBe("number");
    expect(countData).toBeGreaterThanOrEqual(1);
  });
});
