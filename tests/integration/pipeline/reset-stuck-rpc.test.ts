// Integration test for reset_stuck_scoring_repos — reaper correctness.
// Rows stuck in 'scoring' for >15 minutes must revert to 'pending';
// fresher 'scoring' rows (e.g., actively being processed) must stay.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceTestClient } from "@/tests/helpers/test-user";

// biome-ignore lint/suspicious/noExplicitAny: pre-regen typings (new RPC)
let svc: any;
const PREFIX = 900_400_000;

async function seed(status: "scoring" | "pending", updatedMinutesAgo: number): Promise<string> {
  const id = Math.floor(Math.random() * 1_000_000);
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: PREFIX + id,
      owner: `stuck-owner-${id}`,
      name: `stuck-repo-${id}`,
      license: "mit",
      default_branch: "main",
      stars: 10,
      forks: 0,
      watchers: 0,
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed failed");

  // Backdate updated_at to simulate stuckness
  const backdate = new Date(Date.now() - updatedMinutesAgo * 60_000).toISOString();
  await svc.from("repos").update({ updated_at: backdate }).eq("id", data.id);

  return data.id;
}

async function cleanup(): Promise<void> {
  await svc
    .from("repos")
    .delete()
    .gte("github_id", PREFIX)
    .lt("github_id", PREFIX + 1_000_000);
}

describe("reset_stuck_scoring_repos RPC (integration)", () => {
  beforeAll(() => {
    svc = createServiceTestClient();
  });
  afterAll(cleanup);
  beforeEach(cleanup);

  it("resets 'scoring' rows older than 15 minutes to 'pending'", async () => {
    const stuckId = await seed("scoring", 20);

    const { data: count, error } = await svc.rpc("reset_stuck_scoring_repos");
    expect(error).toBeNull();
    expect((count as number) >= 1).toBe(true);

    const { data: row } = await svc.from("repos").select("status").eq("id", stuckId).single();
    expect(row?.status).toBe("pending");
  });

  it("leaves recent 'scoring' rows alone", async () => {
    const recentId = await seed("scoring", 5);

    await svc.rpc("reset_stuck_scoring_repos");

    const { data: row } = await svc.from("repos").select("status").eq("id", recentId).single();
    expect(row?.status).toBe("scoring");
  });

  it("does not touch 'pending' rows", async () => {
    const pendingId = await seed("pending", 60);

    await svc.rpc("reset_stuck_scoring_repos");

    const { data: row } = await svc.from("repos").select("status").eq("id", pendingId).single();
    expect(row?.status).toBe("pending");
  });
});
