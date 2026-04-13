import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestUser,
  createServiceTestClient,
} from "@/tests/helpers/test-user";
import { encryptToken } from "@/lib/crypto/tokens";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";

let svc: SupabaseClient<Database>;

// Helper: create a published repo via service client
async function createRepo(
  status: Database["public"]["Enums"]["repo_status"] = "published",
) {
  const ghId = Math.floor(Math.random() * 1e9);
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: ghId,
      owner: `owner-${ghId}`,
      name: `repo-${ghId}`,
      license: "MIT",
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data;
}

beforeAll(() => {
  svc = createServiceTestClient();
});

// ─────────────────────────────────────────────────────────────────────
// 1. handle_new_user
// ─────────────────────────────────────────────────────────────────────
describe("handle_new_user", () => {
  it("creates user_profiles row on auth.users insert (via createTestUser)", async () => {
    const { userId } = await createTestUser();

    const { data, error } = await svc
      .from("user_profiles")
      .select("id, github_id, github_username")
      .eq("id", userId)
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(userId);
    expect(data?.github_id).toBeGreaterThan(0);
    expect(data?.github_username).toBeTruthy();
  });

  it("fails when user_metadata is empty (missing required GitHub identity)", async () => {
    const email = `test-empty-meta-${crypto.randomUUID()}@example.test`;

    const { error } = await svc.auth.admin.createUser({
      email,
      password: "test-password-safe-for-local-only",
      email_confirm: true,
      user_metadata: {},
    });

    // The trigger raises an exception, which makes the admin createUser call fail
    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. upsert_user_oauth_token
// ─────────────────────────────────────────────────────────────────────
describe("upsert_user_oauth_token", () => {
  it("authenticated user upserts token successfully", async () => {
    const { userId, client } = await createTestUser();
    const dummyToken = encryptToken("ghp_test_token_for_rls", 1);

    const { error } = await client.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(dummyToken) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    expect(error).toBeNull();

    // Verify via service client
    const { data } = await svc
      .from("github_oauth_tokens")
      .select("user_id, scopes, revoked_at")
      .eq("user_id", userId)
      .single();

    expect(data?.user_id).toBe(userId);
    expect(data?.scopes).toContain("public_repo");
    expect(data?.revoked_at).toBeNull();
  });

  it("rejects anonymous caller with 42501", async () => {
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    const dummyToken = encryptToken("ghp_test_anon", 1);

    const { error } = await anon.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(dummyToken) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    expect(error).not.toBeNull();
    // Function is not granted to anon, or raises 42501 inside
    expect(error?.code).toMatch(/42501|PGRST/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. get_my_oauth_token_encrypted
// ─────────────────────────────────────────────────────────────────────
describe("get_my_oauth_token_encrypted", () => {
  it("returns token after upsert", async () => {
    const { client } = await createTestUser();
    const dummyToken = encryptToken("ghp_test_get", 1);

    await client.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(dummyToken) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    const { data, error } = await client.rpc("get_my_oauth_token_encrypted");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].token_key_version).toBe(1);
    expect(data![0].scopes).toContain("public_repo");
  });

  it("raises P0002 when no token exists", async () => {
    const { client } = await createTestUser();

    const { error } = await client.rpc("get_my_oauth_token_encrypted");

    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0002");
  });

  it("raises P0002 when token is revoked", async () => {
    const { userId, client } = await createTestUser();
    const dummyToken = encryptToken("ghp_test_revoked", 1);

    // Upsert a token
    await client.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(dummyToken) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    // Revoke via mark_oauth_token_revoked
    await client.rpc("mark_oauth_token_revoked");

    // Try to read — should get P0002
    const { error } = await client.rpc("get_my_oauth_token_encrypted");

    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0002");
  });

  it("rejects anonymous caller", async () => {
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );

    const { error } = await anon.rpc("get_my_oauth_token_encrypted");

    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. record_fork_event
// ─────────────────────────────────────────────────────────────────────
describe("record_fork_event", () => {
  it("records a fork event for published repo", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");

    const forkId = Math.floor(Math.random() * 1e9);
    const { data, error } = await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: forkId,
      p_github_fork_url: `https://github.com/test/fork-${forkId}`,
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();

    // Verify row via service
    const { data: row } = await svc
      .from("fork_events")
      .select("user_id, repo_id, github_fork_id")
      .eq("user_id", userId)
      .eq("repo_id", repo.id)
      .single();

    expect(row?.github_fork_id).toBe(forkId);
  });

  it("is idempotent on re-call (upsert)", async () => {
    const { client } = await createTestUser();
    const repo = await createRepo("published");

    const forkId1 = Math.floor(Math.random() * 1e9);
    await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: forkId1,
      p_github_fork_url: "https://github.com/test/fork-1",
    });

    const forkId2 = Math.floor(Math.random() * 1e9);
    const { error } = await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: forkId2,
      p_github_fork_url: "https://github.com/test/fork-2",
    });

    expect(error).toBeNull();
  });

  it("rejects non-published repo", async () => {
    const { client } = await createTestUser();
    const repo = await createRepo("pending");

    const { error } = await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: 12345,
      p_github_fork_url: "https://github.com/test/fork",
    });

    expect(error).not.toBeNull();
    // no_data_found
    expect(error?.message).toContain("not found or not published");
  });

  it("rejects anonymous caller", async () => {
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    const repo = await createRepo("published");

    const { error } = await anon.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: 12345,
      p_github_fork_url: "https://github.com/test/fork",
    });

    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. create_review_with_fork_check
// ─────────────────────────────────────────────────────────────────────
describe("create_review_with_fork_check", () => {
  it("creates review when user has forked the repo", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");

    // Create fork event first
    await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: Math.floor(Math.random() * 1e9),
      p_github_fork_url: "https://github.com/test/fork",
    });

    const { data, error } = await client.rpc("create_review_with_fork_check", {
      p_repo_id: repo.id,
      p_rating: 4,
      p_text_body: "Great repo!",
      p_vibecoding_tool: "cursor",
    });

    expect(error).toBeNull();
    expect(data).toBeDefined();

    // Verify review exists
    const { data: review } = await svc
      .from("reviews")
      .select("user_id, rating, text_body")
      .eq("repo_id", repo.id)
      .eq("user_id", userId)
      .single();

    expect(review?.rating).toBe(4);
    expect(review?.text_body).toBe("Great repo!");
  });

  it("rejects user without fork_events row", async () => {
    const { client } = await createTestUser();
    const repo = await createRepo("published");

    const { error } = await client.rpc("create_review_with_fork_check", {
      p_repo_id: repo.id,
      p_rating: 4,
      p_text_body: "No fork",
      p_vibecoding_tool: "cursor",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("has not forked");
  });

  it("rejects rating out of range (0)", async () => {
    const { client } = await createTestUser();
    const repo = await createRepo("published");

    // Create fork first
    await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: Math.floor(Math.random() * 1e9),
      p_github_fork_url: "https://github.com/test/fork",
    });

    const { error } = await client.rpc("create_review_with_fork_check", {
      p_repo_id: repo.id,
      p_rating: 0,
      p_text_body: "Bad rating",
      p_vibecoding_tool: "cursor",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("rating must be 1..5");
  });

  it("rejects rating out of range (6)", async () => {
    const { client } = await createTestUser();
    const repo = await createRepo("published");

    await client.rpc("record_fork_event", {
      p_repo_id: repo.id,
      p_github_fork_id: Math.floor(Math.random() * 1e9),
      p_github_fork_url: "https://github.com/test/fork",
    });

    const { error } = await client.rpc("create_review_with_fork_check", {
      p_repo_id: repo.id,
      p_rating: 6,
      p_text_body: "Bad rating",
      p_vibecoding_tool: "cursor",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("rating must be 1..5");
  });

  it("rejects non-published repo", async () => {
    const { client } = await createTestUser();
    const repo = await createRepo("pending");

    // Create fork via service (bypass the function's published check for fork)
    const { userId } = await createTestUser();
    // We need the actual user, let's redo
    const user = await createTestUser();

    // Insert fork via service to bypass record_fork_event's published check
    await svc.from("fork_events").insert({
      user_id: user.userId,
      repo_id: repo.id,
      github_fork_id: Math.floor(Math.random() * 1e9),
      github_fork_url: "https://github.com/test/fork",
    });

    const { error } = await user.client.rpc("create_review_with_fork_check", {
      p_repo_id: repo.id,
      p_rating: 4,
      p_text_body: "Should fail",
      p_vibecoding_tool: "cursor",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("not published");
  });

  it("rejects anonymous caller", async () => {
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    const repo = await createRepo("published");

    const { error } = await anon.rpc("create_review_with_fork_check", {
      p_repo_id: repo.id,
      p_rating: 4,
      p_text_body: "Anon",
      p_vibecoding_tool: "cursor",
    });

    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. mark_oauth_token_revoked
// ─────────────────────────────────────────────────────────────────────
describe("mark_oauth_token_revoked", () => {
  it("sets revoked_at on active token", async () => {
    const { userId, client } = await createTestUser();
    const dummyToken = encryptToken("ghp_test_revoke_target", 1);

    await client.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(dummyToken) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    const { error } = await client.rpc("mark_oauth_token_revoked");
    expect(error).toBeNull();

    // Verify via service
    const { data } = await svc
      .from("github_oauth_tokens")
      .select("revoked_at")
      .eq("user_id", userId)
      .single();

    expect(data?.revoked_at).not.toBeNull();
  });

  it("is idempotent (calling twice doesn't error)", async () => {
    const { client } = await createTestUser();
    const dummyToken = encryptToken("ghp_test_revoke_idem", 1);

    await client.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(dummyToken) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    await client.rpc("mark_oauth_token_revoked");
    const { error } = await client.rpc("mark_oauth_token_revoked");

    expect(error).toBeNull();
  });

  it("rejects anonymous caller", async () => {
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );

    const { error } = await anon.rpc("mark_oauth_token_revoked");

    expect(error).not.toBeNull();
  });
});
