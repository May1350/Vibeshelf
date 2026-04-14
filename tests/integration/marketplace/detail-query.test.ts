// Integration tests for get_repo_detail RPC.
// Covers:
//   * Published repo: returns full jsonb row.
//   * Non-existent repo: returns null.
//   * Non-published (pending) repo: RLS hides it → anon client gets null.
//
// The RPC itself is SECURITY INVOKER and already filters WHERE status='published',
// so pending rows return null even for the service role. But to defend against
// future loosening, the third test explicitly uses an anon client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { createAnonTestClient, createServiceTestClient } from "@/tests/helpers/test-user";

const GH_ID_BASE = 900_700_000;
const GH_ID_TOP = 900_701_000;

// RPC types regen pending; cast-to-any for rpc() call shape.
let svc: SupabaseClient<Database> & { rpc: (name: string, args: any) => any };
let anon: SupabaseClient<Database> & { rpc: (name: string, args: any) => any };

async function cleanup(): Promise<void> {
  await svc.from("repos").delete().gte("github_id", GH_ID_BASE).lt("github_id", GH_ID_TOP);
}

async function seed(opts: {
  offset: number;
  owner: string;
  name: string;
  status?: Database["public"]["Enums"]["repo_status"];
  withScore?: boolean;
}): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: GH_ID_BASE + opts.offset,
      owner: opts.owner,
      name: opts.name,
      license: "MIT",
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status: opts.status ?? "published",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("insert failed");
  if (opts.withScore !== false) {
    // database.types.ts stale — matches lib/marketplace cast-to-any convention.
    const svcAny = svc as any;
    await svcAny.from("repo_scores").insert({
      repo_id: data.id,
      documentation_score: 4,
      maintenance_score: 4,
      popularity_score: 4,
      code_health_score: 4,
      visual_preview_score: 4,
      scoring_model: "fixture",
      scoring_prompt_version: "1.0.0",
      is_latest: true,
      evidence_strength: "strong",
    });
  }
  return { id: data.id };
}

beforeAll(async () => {
  svc = createServiceTestClient() as SupabaseClient<Database> & {
    rpc: (name: string, args: any) => any;
  };
  anon = createAnonTestClient() as SupabaseClient<Database> & {
    rpc: (name: string, args: any) => any;
  };
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("get_repo_detail", () => {
  it("returns the row for a published (owner, name) pair", async () => {
    await seed({ offset: 1, owner: "dq-owner-a", name: "r-pub" });

    const { data, error } = await svc.rpc("get_repo_detail", {
      p_owner: "dq-owner-a",
      p_name: "r-pub",
    });
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data.owner).toBe("dq-owner-a");
    expect(data.name).toBe("r-pub");
    // Tag aggregates present (even if empty)
    expect(Array.isArray(data.feature_tags)).toBe(true);
    expect(Array.isArray(data.tech_stack_tags)).toBe(true);
    expect(Array.isArray(data.vibecoding_tags)).toBe(true);
  });

  it("returns null for a non-existent (owner, name) pair", async () => {
    const { data, error } = await svc.rpc("get_repo_detail", {
      p_owner: "nobody-here",
      p_name: "no-such-repo",
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("returns null for a non-published repo (RLS hides via anon client)", async () => {
    await seed({ offset: 2, owner: "dq-owner-b", name: "r-pending", status: "pending" });

    const { data, error } = await anon.rpc("get_repo_detail", {
      p_owner: "dq-owner-b",
      p_name: "r-pending",
    });
    expect(error).toBeNull();
    // RPC filter: WHERE r.status = 'published' — so pending = null
    expect(data).toBeNull();
  });
});
