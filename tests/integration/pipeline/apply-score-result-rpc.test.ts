// Integration test for apply_score_result RPC — atomicity + gate logic.
// Requires running Supabase (Docker). Skipped when unavailable.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceTestClient } from "@/tests/helpers/test-user";

// database.types.ts was not regenerated after sub-project #3 migrations
// (Docker unavailable locally). Cast to any for new-RPC calls; types will
// be proper once `pnpm db:types` runs post-merge.
// biome-ignore lint/suspicious/noExplicitAny: pre-regen typings
let svc: any;

const FIXTURE_REPO = {
  github_id: 900_200_001,
  owner: "fixture-asr-owner",
  name: "fixture-asr-repo",
};

async function seedRepo(status: string, assetsExtracted = true): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: FIXTURE_REPO.github_id,
      owner: FIXTURE_REPO.owner,
      name: FIXTURE_REPO.name,
      license: "mit",
      default_branch: "main",
      stars: 100,
      forks: 10,
      watchers: 5,
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      readme_sha: "seeded-sha",
      status,
      assets_extracted_at: assetsExtracted ? now : null,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedRepo failed");
  return data.id;
}

async function cleanup(): Promise<void> {
  const { data: repos } = await svc
    .from("repos")
    .select("id")
    .eq("github_id", FIXTURE_REPO.github_id);
  const ids = (repos ?? []).map((r: { id: string }) => r.id);
  if (ids.length > 0) {
    await svc.from("repo_tags").delete().in("repo_id", ids);
    await svc.from("repo_scores").delete().in("repo_id", ids);
    await svc.from("repos").delete().in("id", ids);
  }
}

async function callRpc(
  repoId: string,
  isRescore: boolean,
  totalInputs: {
    doc: number;
    codeHealth: number;
    maint: number;
    pop: number;
    visual: number;
    evidence: "strong" | "partial" | "weak";
    category?: string;
  },
): Promise<string> {
  const { data, error } = await svc.rpc("apply_score_result", {
    p_repo_id: repoId,
    p_documentation_score: totalInputs.doc,
    p_code_health_score: totalInputs.codeHealth,
    p_maintenance_score: totalInputs.maint,
    p_popularity_score: totalInputs.pop,
    p_visual_preview_score: totalInputs.visual,
    p_category: totalInputs.category ?? "saas",
    p_canonical_tag_ids: [],
    p_canonical_confidences: [],
    p_freeform_tags: [],
    p_rationale: {},
    p_evidence_strength: totalInputs.evidence,
    p_prompt_version: "1.0.0",
    p_model: "gemini-flash-lite-latest",
    p_run_id: null,
    p_is_rescore: isRescore,
  });
  if (error) throw new Error(`rpc failed: ${error.message}`);
  return data as string;
}

describe("apply_score_result RPC (integration)", () => {
  beforeAll(() => {
    svc = createServiceTestClient();
  });
  afterAll(cleanup);
  beforeEach(cleanup);

  it("high scores + strong evidence → status='published'", async () => {
    const repoId = await seedRepo("scoring");
    const status = await callRpc(repoId, false, {
      doc: 5,
      codeHealth: 5,
      maint: 5,
      pop: 5,
      visual: 5,
      evidence: "strong",
    });
    expect(status).toBe("published");
  });

  it("weak evidence → status='needs_review'", async () => {
    const repoId = await seedRepo("scoring");
    const status = await callRpc(repoId, false, {
      doc: 5,
      codeHealth: 5,
      maint: 5,
      pop: 5,
      visual: 5,
      evidence: "weak",
    });
    expect(status).toBe("needs_review");
  });

  it("low total_score (<2.5) → status='needs_review'", async () => {
    const repoId = await seedRepo("scoring");
    const status = await callRpc(repoId, false, {
      doc: 1,
      codeHealth: 1,
      maint: 1,
      pop: 1,
      visual: 1,
      evidence: "partial",
    });
    expect(status).toBe("needs_review");
  });

  it("low visual_preview + assets_extracted_at set → status='scored' (gated)", async () => {
    const repoId = await seedRepo("scoring", true);
    const status = await callRpc(repoId, false, {
      doc: 5,
      codeHealth: 5,
      maint: 5,
      pop: 5,
      visual: 0,
      evidence: "partial",
    });
    expect(status).toBe("scored");
  });

  it("low visual_preview + assets_extracted_at NULL → skips visual gate", async () => {
    const repoId = await seedRepo("scoring", false);
    const status = await callRpc(repoId, false, {
      doc: 5,
      codeHealth: 5,
      maint: 5,
      pop: 5,
      visual: 0,
      evidence: "partial",
    });
    // total = 5×0.20 + 5×0.25 + 5×0.20 + 5×0.15 + 0×0.20 = 4.0 ≥ 2.5 → published
    expect(status).toBe("published");
  });

  it("rescore + published repo + low total → grandfathered", async () => {
    const repoId = await seedRepo("published");
    const status = await callRpc(repoId, true, {
      doc: 1,
      codeHealth: 1,
      maint: 1,
      pop: 1,
      visual: 1,
      evidence: "partial",
    });
    expect(status).toBe("published");

    const { data: repo } = await svc
      .from("repos")
      .select("grandfathered_at")
      .eq("id", repoId)
      .single();
    expect(repo?.grandfathered_at).not.toBeNull();
  });

  it("is_latest invariant: exactly one latest row after 2 consecutive RPCs", async () => {
    const repoId = await seedRepo("scoring");
    await callRpc(repoId, false, {
      doc: 3,
      codeHealth: 3,
      maint: 3,
      pop: 3,
      visual: 3,
      evidence: "strong",
    });
    await callRpc(repoId, true, {
      doc: 4,
      codeHealth: 4,
      maint: 4,
      pop: 4,
      visual: 4,
      evidence: "strong",
    });

    const { data: scores } = await svc
      .from("repo_scores")
      .select("is_latest")
      .eq("repo_id", repoId);
    const latest = (scores ?? []).filter((s: { is_latest: boolean }) => s.is_latest);
    expect(latest.length).toBe(1);
    expect((scores ?? []).length).toBe(2);
  });
});
