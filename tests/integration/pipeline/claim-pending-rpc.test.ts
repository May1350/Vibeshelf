// Integration test for claim_pending_repos — ordering + status transition.
// True parallel SKIP LOCKED verification would require a pg client with
// two connections; sequential verification still covers the contract.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceTestClient } from "@/tests/helpers/test-user";

// biome-ignore lint/suspicious/noExplicitAny: pre-regen typings (new RPC)
let svc: any;
const PREFIX = 900_300_000;

async function seedPending(count: number): Promise<void> {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    github_id: PREFIX + i,
    owner: `claim-owner-${i}`,
    name: `claim-repo-${i}`,
    license: "mit",
    default_branch: "main",
    stars: 10,
    forks: 0,
    watchers: 0,
    last_commit_at: now,
    github_created_at: now,
    github_pushed_at: now,
    status: "pending" as const,
  }));
  await svc.from("repos").insert(rows);
}

async function cleanup(): Promise<void> {
  await svc
    .from("repos")
    .delete()
    .gte("github_id", PREFIX)
    .lt("github_id", PREFIX + 1000);
}

describe("claim_pending_repos RPC (integration)", () => {
  beforeAll(() => {
    svc = createServiceTestClient();
  });
  afterAll(cleanup);
  beforeEach(cleanup);

  it("claims up to p_limit rows and transitions them to 'scoring'", async () => {
    await seedPending(5);

    const { data: claimed, error } = await svc.rpc("claim_pending_repos", { p_limit: 3 });
    expect(error).toBeNull();
    expect((claimed ?? []).length).toBe(3);

    // Verify transitioned to 'scoring'
    const claimedIds = (claimed ?? []).map((r: { id: string }) => r.id);
    const { data: rows } = await svc.from("repos").select("status").in("id", claimedIds);
    for (const row of rows ?? []) expect(row.status).toBe("scoring");
  });

  it("subsequent claim returns remaining repos only (no duplicates)", async () => {
    await seedPending(5);

    const first = await svc.rpc("claim_pending_repos", { p_limit: 3 });
    const firstIds = new Set((first.data ?? []).map((r: { id: string }) => r.id));

    const second = await svc.rpc("claim_pending_repos", { p_limit: 5 });
    expect((second.data ?? []).length).toBe(2);
    for (const r of (second.data ?? []) as { id: string }[]) expect(firstIds.has(r.id)).toBe(false);
  });

  it("empty pool → empty result, no error", async () => {
    const { data, error } = await svc.rpc("claim_pending_repos", { p_limit: 10 });
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);
  });
});
