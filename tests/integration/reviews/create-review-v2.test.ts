// Covers SP#5 migration 20260417000004 — create_review_with_fork_check_v2 RPC
// (Task 3). Per spec §3.5 the v2 replaces v1 with:
//   - 30-second grace window on fork_events.verified_at = NULL
//   - 23505 (unique_violation) translated to P0001 'already_reviewed'
//   - Bounded rating (1-5) + ≤5 image keys validation
//   - One-at-a-time asset insert that honors the per-row
//     enforce_review_asset_limit BEFORE INSERT trigger.
//
// This suite exercises all seven branches of the RPC.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceTestClient, createTestUser } from "@/tests/helpers/test-user";

// svc is typed as any because new RPC v2 types will regen only post-merge.
let svc: any;
const PREFIX = 900_800_000;

async function seedRepo(i: number): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: PREFIX + i,
      owner: `r2-owner-${i}`,
      name: `r2-repo-${i}`,
      license: "mit",
      default_branch: "main",
      stars: 1,
      forks: 0,
      watchers: 0,
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status: "published",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedRepo failed");
  return data.id as string;
}

async function seedFork(
  repoId: string,
  userId: string,
  opts: { verified?: boolean; ageSeconds?: number },
): Promise<void> {
  const forkedAt = new Date(Date.now() - (opts.ageSeconds ?? 0) * 1000).toISOString();
  const { error } = await svc.from("fork_events").insert({
    user_id: userId,
    repo_id: repoId,
    github_fork_id: Math.floor(Math.random() * 1_000_000) + 900_000_000,
    github_fork_url: `https://github.com/test/${repoId}`,
    forked_at: forkedAt,
    verified_at: opts.verified ? new Date().toISOString() : null,
  });
  if (error) throw error;
}

async function cleanup(): Promise<void> {
  const { data: repos } = await svc
    .from("repos")
    .select("id")
    .gte("github_id", PREFIX)
    .lt("github_id", PREFIX + 1000);
  const repoIds = (repos ?? []).map((r: { id: string }) => r.id);
  if (repoIds.length === 0) return;

  const { data: reviewRows } = await svc.from("reviews").select("id").in("repo_id", repoIds);
  const reviewIds = (reviewRows ?? []).map((r: { id: string }) => r.id);
  if (reviewIds.length > 0) {
    await svc.from("review_assets").delete().in("review_id", reviewIds);
  }
  await svc.from("reviews").delete().in("repo_id", repoIds);
  await svc.from("fork_events").delete().in("repo_id", repoIds);
  await svc.from("repos").delete().in("id", repoIds);
}

describe("create_review_with_fork_check_v2 RPC (SP#5 migration 4)", () => {
  beforeAll(async () => {
    svc = createServiceTestClient();
    await cleanup();
  });
  afterAll(cleanup);
  beforeEach(cleanup);

  it("verified fork → creates review + assets in order", async () => {
    const repoId = await seedRepo(1);
    const { userId, client } = await createTestUser();
    await seedFork(repoId, userId, { verified: true });

    const { data, error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 5,
      p_text_body: "great",
      p_vibecoding_tool: "cursor",
      p_image_keys: [`${userId}/pending/abc.png`, `${userId}/pending/def.jpg`],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const { data: assets } = await svc
      .from("review_assets")
      .select("storage_key, ordering")
      .eq("review_id", data)
      .order("ordering", { ascending: true });
    expect(assets).toHaveLength(2);
    expect(assets?.[0]?.ordering).toBe(0);
    expect(assets?.[1]?.ordering).toBe(1);
  });

  it("grace window (forked within 30s, not verified) → success", async () => {
    const repoId = await seedRepo(2);
    const { userId, client } = await createTestUser();
    await seedFork(repoId, userId, { verified: false, ageSeconds: 5 });

    const { data, error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 4,
      p_text_body: null,
      p_vibecoding_tool: null,
      p_image_keys: [],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });

  it("no fork → fork_required error", async () => {
    const repoId = await seedRepo(3);
    const { client } = await createTestUser();

    const { error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 3,
      p_text_body: null,
      p_vibecoding_tool: null,
      p_image_keys: [],
    });
    expect(error?.message).toContain("fork_required");
  });

  it("unverified fork beyond grace → fork_required error", async () => {
    const repoId = await seedRepo(4);
    const { userId, client } = await createTestUser();
    await seedFork(repoId, userId, { verified: false, ageSeconds: 60 });

    const { error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 3,
      p_text_body: null,
      p_vibecoding_tool: null,
      p_image_keys: [],
    });
    expect(error?.message).toContain("fork_required");
  });

  it("already reviewed (23505) → already_reviewed error", async () => {
    const repoId = await seedRepo(5);
    const { userId, client } = await createTestUser();
    await seedFork(repoId, userId, { verified: true });

    const first = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 5,
      p_text_body: "first",
      p_vibecoding_tool: null,
      p_image_keys: [],
    });
    expect(first.error).toBeNull();

    const { error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 4,
      p_text_body: "second",
      p_vibecoding_tool: null,
      p_image_keys: [],
    });
    expect(error?.message).toContain("already_reviewed");
  });

  it("rating out of range → rating_out_of_range error", async () => {
    const repoId = await seedRepo(6);
    const { userId, client } = await createTestUser();
    await seedFork(repoId, userId, { verified: true });

    const { error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 6,
      p_text_body: null,
      p_vibecoding_tool: null,
      p_image_keys: [],
    });
    expect(error?.message).toContain("rating_out_of_range");
  });

  it("too many images → too_many_images error", async () => {
    const repoId = await seedRepo(7);
    const { userId, client } = await createTestUser();
    await seedFork(repoId, userId, { verified: true });

    const keys = Array.from({ length: 6 }, (_, i) => `${userId}/pending/${i}.png`);
    const { error } = await (client as any).rpc("create_review_with_fork_check_v2", {
      p_repo_id: repoId,
      p_rating: 3,
      p_text_body: null,
      p_vibecoding_tool: null,
      p_image_keys: keys,
    });
    expect(error?.message).toContain("too_many_images");
  });
});
