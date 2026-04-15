// Covers SP#5 migration 20260415000001 — reviews.hidden_at soft-hide
// RLS behavior (Task 1).
//
// Verifies two invariants added by the migration:
//   1. reviews_select_published now filters hidden_at IS NOT NULL rows
//      from anon/public reads.
//   2. reviews_select_own lets the author still SELECT their own hidden
//      row — required so RLS UPDATE/DELETE USING (auth.uid() = user_id)
//      has a readable row to evaluate against.
//
// Writes go through the service-role client (bypassing RLS), matching
// the pattern in tests/integration/rls/policies.test.ts — the Foundation
// `reviews` table has no INSERT policy for authenticated users; rows are
// inserted only by create_review_with_fork_check() SECURITY DEFINER.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAnonTestClient,
  createServiceTestClient,
  createTestUser,
} from "@/tests/helpers/test-user";

let svc: any;
let anon: any;
const PREFIX = 900_700_000;

async function cleanup(): Promise<void> {
  const { data: repos } = await svc
    .from("repos")
    .select("id")
    .gte("github_id", PREFIX)
    .lt("github_id", PREFIX + 1000);
  const repoIds = (repos ?? []).map((r: { id: string }) => r.id);
  if (repoIds.length > 0) {
    await svc.from("reviews").delete().in("repo_id", repoIds);
    await svc.from("fork_events").delete().in("repo_id", repoIds);
    await svc.from("repos").delete().in("id", repoIds);
  }
}

async function seedRepo(i: number): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: PREFIX + i,
      owner: `hidden-owner-${i}`,
      name: `hidden-repo-${i}`,
      license: "mit",
      default_branch: "main",
      stars: 10,
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

describe("reviews.hidden_at + RLS (SP#5 migration 1)", () => {
  beforeAll(async () => {
    svc = createServiceTestClient();
    anon = createAnonTestClient();
    await cleanup();
  });
  afterAll(cleanup);
  beforeEach(cleanup);

  it("anon SELECT excludes hidden reviews", async () => {
    const repoId = await seedRepo(1);
    const { userId: userAId } = await createTestUser();
    const { userId: userBId } = await createTestUser();

    // Service-role inserts bypass RLS — matches the Foundation pattern
    // since reviews has no INSERT policy for authenticated users.
    await svc.from("reviews").insert([
      { repo_id: repoId, user_id: userAId, rating: 5, text_body: "visible" },
      { repo_id: repoId, user_id: userBId, rating: 4, text_body: "hidden" },
    ]);

    // Hide userB's row.
    const { error: hideErr } = await svc
      .from("reviews")
      .update({ hidden_at: new Date().toISOString() })
      .eq("user_id", userBId)
      .eq("repo_id", repoId);
    expect(hideErr).toBeNull();

    // Anon sees only the un-hidden row.
    const { data, error } = await anon
      .from("reviews")
      .select("id, text_body")
      .eq("repo_id", repoId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.text_body).toBe("visible");
  });

  it("author SELECT includes their own hidden review", async () => {
    const repoId = await seedRepo(2);
    const { userId: userAId, client: userAClient } = await createTestUser();

    await svc.from("reviews").insert({
      repo_id: repoId,
      user_id: userAId,
      rating: 3,
      text_body: "own hidden",
    });

    await svc
      .from("reviews")
      .update({ hidden_at: new Date().toISOString() })
      .eq("user_id", userAId)
      .eq("repo_id", repoId);

    // userA authenticated: reviews_select_own should surface the hidden row
    // even though reviews_select_published would filter it out.
    const userClient: any = userAClient;
    const { data, error } = await userClient
      .from("reviews")
      .select("id, hidden_at, text_body")
      .eq("repo_id", repoId)
      .eq("user_id", userAId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.hidden_at).not.toBeNull();
    expect(data?.[0]?.text_body).toBe("own hidden");
  });
});
