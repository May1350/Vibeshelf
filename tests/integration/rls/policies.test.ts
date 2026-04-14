import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/database.types";
import {
  createAnonTestClient,
  createServiceTestClient,
  createTestUser,
} from "@/tests/helpers/test-user";

// Shared state across test groups
let svc: SupabaseClient<Database>;

// Helper: create a published repo via service client
async function createRepo(status: Database["public"]["Enums"]["repo_status"] = "published") {
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

// Helper: create a review via service client (bypassing RLS)
async function createReview(repoId: string, userId: string, rating = 4) {
  const { data, error } = await svc
    .from("reviews")
    .insert({
      repo_id: repoId,
      user_id: userId,
      rating,
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
// 1. user_profiles
// ─────────────────────────────────────────────────────────────────────
describe("user_profiles_select_all", () => {
  it("allows any authenticated user to select any profile", async () => {
    const { client: userA } = await createTestUser();
    const { userId: userBId } = await createTestUser();

    const { data, error } = await userA
      .from("user_profiles")
      .select("id")
      .eq("id", userBId)
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(userBId);
  });

  it("allows anon to select profiles", async () => {
    const { userId } = await createTestUser();
    const anon = createAnonTestClient();

    const { data, error } = await anon.from("user_profiles").select("id").eq("id", userId).single();

    expect(error).toBeNull();
    expect(data?.id).toBe(userId);
  });
});

describe("user_profiles_update_own", () => {
  it("allows user to update own display_name", async () => {
    const { userId, client } = await createTestUser();

    const { error } = await client
      .from("user_profiles")
      .update({ display_name: "New Name" })
      .eq("id", userId);

    expect(error).toBeNull();

    const { data } = await client
      .from("user_profiles")
      .select("display_name")
      .eq("id", userId)
      .single();

    expect(data?.display_name).toBe("New Name");
  });

  it("allows user to update own avatar_url", async () => {
    const { userId, client } = await createTestUser();

    const { error } = await client
      .from("user_profiles")
      .update({ avatar_url: "https://example.com/new-avatar.png" })
      .eq("id", userId);

    expect(error).toBeNull();
  });

  it("denies user updating another user's row", async () => {
    const { client: userA } = await createTestUser();
    const { userId: userBId } = await createTestUser();

    const { data, error } = await userA
      .from("user_profiles")
      .update({ display_name: "Hacked" })
      .eq("id", userBId)
      .select();

    // RLS blocks the update silently — no rows affected
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("denies user updating own github_id (column grant)", async () => {
    const { userId, client } = await createTestUser();

    // Attempt to update a column the user doesn't have grant for
    const { error } = await client
      .from("user_profiles")
      // Cast to any: we intentionally update a column the user lacks GRANT for,
      // and the types now exclude it. Postgres returns 42501 at runtime.
      // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
      .update({ github_id: 999999 } as any)
      .eq("id", userId);

    // PostgREST returns 42501 (permission denied) for column-level grant violations
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. github_oauth_tokens — deny-all for authenticated
// ─────────────────────────────────────────────────────────────────────
describe("github_oauth_tokens (deny-all)", () => {
  it("allows service role to select", async () => {
    const { data, error } = await svc.from("github_oauth_tokens").select("user_id").limit(1);

    expect(error).toBeNull();
    expect(data).toBeDefined();
  });

  it("denies authenticated user select", async () => {
    const { client } = await createTestUser();

    const { data } = await client.from("github_oauth_tokens").select("user_id").limit(1);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2b. github_tokens — deny-all for authenticated
// ─────────────────────────────────────────────────────────────────────
describe("github_tokens (deny-all)", () => {
  it("allows service role to select", async () => {
    const { data, error } = await svc.from("github_tokens").select("id").limit(1);

    expect(error).toBeNull();
    expect(data).toBeDefined();
  });

  it("denies authenticated user select", async () => {
    const { client } = await createTestUser();

    const { data } = await client.from("github_tokens").select("id").limit(1);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. repos_select_published
// ─────────────────────────────────────────────────────────────────────
describe("repos_select_published", () => {
  it("allows authenticated to see published repo", async () => {
    const repo = await createRepo("published");
    const { client } = await createTestUser();

    const { data, error } = await client.from("repos").select("id").eq("id", repo.id).single();

    expect(error).toBeNull();
    expect(data?.id).toBe(repo.id);
  });

  it("denies authenticated seeing pending repo", async () => {
    const repo = await createRepo("pending");
    const { client } = await createTestUser();

    const { data } = await client.from("repos").select("id").eq("id", repo.id);

    expect(data).toHaveLength(0);
  });

  it("denies authenticated seeing removed repo", async () => {
    const repo = await createRepo("removed");
    const { client } = await createTestUser();

    const { data } = await client.from("repos").select("id").eq("id", repo.id);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. repo_scores_select_latest_published
// ─────────────────────────────────────────────────────────────────────
describe("repo_scores_select_latest_published", () => {
  it("allows authenticated to see latest score of published repo", async () => {
    const repo = await createRepo("published");

    const { data: score } = await svc
      .from("repo_scores")
      .insert({
        repo_id: repo.id,
        documentation_score: 4.0,
        maintenance_score: 3.5,
        popularity_score: 4.5,
        code_health_score: 4.0,
        vibecoding_compat_score: 3.0,
        total_score: 3.8,
        scoring_model: "test-model",
        scoring_prompt_version: "v1",
        is_latest: true,
      })
      .select("id")
      .single();

    const { client } = await createTestUser();

    const { data, error } = await client
      .from("repo_scores")
      .select("id")
      .eq("id", score!.id)
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(score!.id);
  });

  it("denies seeing is_latest=false row", async () => {
    const repo = await createRepo("published");

    const { data: score } = await svc
      .from("repo_scores")
      .insert({
        repo_id: repo.id,
        documentation_score: 4.0,
        maintenance_score: 3.5,
        popularity_score: 4.5,
        code_health_score: 4.0,
        vibecoding_compat_score: 3.0,
        total_score: 3.8,
        scoring_model: "test-model",
        scoring_prompt_version: "v1",
        is_latest: false,
      })
      .select("id")
      .single();

    const { client } = await createTestUser();

    const { data } = await client.from("repo_scores").select("id").eq("id", score!.id);

    expect(data).toHaveLength(0);
  });

  it("denies seeing score of unpublished repo", async () => {
    const repo = await createRepo("pending");

    const { data: score } = await svc
      .from("repo_scores")
      .insert({
        repo_id: repo.id,
        documentation_score: 4.0,
        maintenance_score: 3.5,
        popularity_score: 4.5,
        code_health_score: 4.0,
        vibecoding_compat_score: 3.0,
        total_score: 3.8,
        scoring_model: "test-model",
        scoring_prompt_version: "v1",
        is_latest: true,
      })
      .select("id")
      .single();

    const { client } = await createTestUser();

    const { data } = await client.from("repo_scores").select("id").eq("id", score!.id);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. tags_select_all
// ─────────────────────────────────────────────────────────────────────
describe("tags_select_all", () => {
  it("allows authenticated to see all tags", async () => {
    const slug = `test-tag-${crypto.randomUUID().slice(0, 8)}`;
    await svc.from("tags").insert({
      slug,
      kind: "tech_stack",
      label: "Test Tag",
    });

    const { client } = await createTestUser();

    const { data, error } = await client.from("tags").select("slug").eq("slug", slug).single();

    expect(error).toBeNull();
    expect(data?.slug).toBe(slug);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. repo_tags_select_published
// ─────────────────────────────────────────────────────────────────────
describe("repo_tags_select_published", () => {
  it("allows seeing tags on published repo", async () => {
    const repo = await createRepo("published");
    const slug = `tag-pub-${crypto.randomUUID().slice(0, 8)}`;

    const { data: tag } = await svc
      .from("tags")
      .insert({ slug, kind: "tech_stack", label: slug })
      .select("id")
      .single();

    await svc.from("repo_tags").insert({
      repo_id: repo.id,
      tag_id: tag!.id,
      source: "ai",
    });

    const { client } = await createTestUser();

    const { data, error } = await client.from("repo_tags").select("tag_id").eq("repo_id", repo.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("denies seeing tags on pending repo", async () => {
    const repo = await createRepo("pending");
    const slug = `tag-pend-${crypto.randomUUID().slice(0, 8)}`;

    const { data: tag } = await svc
      .from("tags")
      .insert({ slug, kind: "tech_stack", label: slug })
      .select("id")
      .single();

    await svc.from("repo_tags").insert({
      repo_id: repo.id,
      tag_id: tag!.id,
      source: "ai",
    });

    const { client } = await createTestUser();

    const { data } = await client.from("repo_tags").select("tag_id").eq("repo_id", repo.id);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. repo_assets_select_published
// ─────────────────────────────────────────────────────────────────────
describe("repo_assets_select_published", () => {
  it("allows seeing assets on published repo", async () => {
    const repo = await createRepo("published");

    await svc.from("repo_assets").insert({
      repo_id: repo.id,
      kind: "readme_image",
      external_url: "https://example.com/img.png",
    });

    const { client } = await createTestUser();

    const { data, error } = await client.from("repo_assets").select("id").eq("repo_id", repo.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("denies seeing assets on pending repo", async () => {
    const repo = await createRepo("pending");

    await svc.from("repo_assets").insert({
      repo_id: repo.id,
      kind: "readme_image",
      external_url: "https://example.com/img.png",
    });

    const { client } = await createTestUser();

    const { data } = await client.from("repo_assets").select("id").eq("repo_id", repo.id);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. fork_events_select_own
// ─────────────────────────────────────────────────────────────────────
describe("fork_events_select_own", () => {
  it("allows user to see own fork_events", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");

    await svc.from("fork_events").insert({
      user_id: userId,
      repo_id: repo.id,
      github_fork_id: Math.floor(Math.random() * 1e9),
      github_fork_url: "https://github.com/test/fork",
    });

    const { data, error } = await client.from("fork_events").select("id").eq("repo_id", repo.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("denies user seeing another user's fork_events", async () => {
    const { userId: userAId } = await createTestUser();
    const { client: userBClient } = await createTestUser();
    const repo = await createRepo("published");

    await svc.from("fork_events").insert({
      user_id: userAId,
      repo_id: repo.id,
      github_fork_id: Math.floor(Math.random() * 1e9),
      github_fork_url: "https://github.com/test/fork",
    });

    const { data } = await userBClient.from("fork_events").select("id").eq("repo_id", repo.id);

    expect(data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. reviews
// ─────────────────────────────────────────────────────────────────────
describe("reviews_select_published", () => {
  it("allows seeing review on published repo", async () => {
    const { userId } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, userId);

    const { client } = await createTestUser();

    const { data, error } = await client.from("reviews").select("id").eq("id", review.id).single();

    expect(error).toBeNull();
    expect(data?.id).toBe(review.id);
  });

  it("denies seeing review on removed repo", async () => {
    const { userId } = await createTestUser();
    const repo = await createRepo("removed");
    const review = await createReview(repo.id, userId);

    const { client } = await createTestUser();

    const { data } = await client.from("reviews").select("id").eq("id", review.id);

    expect(data).toHaveLength(0);
  });
});

describe("reviews_update_own", () => {
  it("allows user to update own review", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");
    await createReview(repo.id, userId);

    const { data, error } = await client
      .from("reviews")
      .update({ text_body: "Updated review text" })
      .eq("repo_id", repo.id)
      .eq("user_id", userId)
      .select("text_body");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.text_body).toBe("Updated review text");
  });

  it("denies user updating another user's review", async () => {
    const { userId: ownerUserId } = await createTestUser();
    const { client: otherClient } = await createTestUser();
    const repo = await createRepo("published");
    await createReview(repo.id, ownerUserId);

    const { data } = await otherClient
      .from("reviews")
      .update({ text_body: "Hacked" })
      .eq("repo_id", repo.id)
      .eq("user_id", ownerUserId)
      .select();

    expect(data).toHaveLength(0);
  });
});

describe("reviews_delete_own", () => {
  it("allows user to delete own review", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, userId);

    const { error } = await client.from("reviews").delete().eq("id", review.id);

    expect(error).toBeNull();

    // Verify deleted via service
    const { data } = await svc.from("reviews").select("id").eq("id", review.id);

    expect(data).toHaveLength(0);
  });

  it("denies user deleting another user's review", async () => {
    const { userId: ownerUserId } = await createTestUser();
    const { client: otherClient } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, ownerUserId);

    await otherClient.from("reviews").delete().eq("id", review.id);

    // Verify NOT deleted via service
    const { data } = await svc.from("reviews").select("id").eq("id", review.id);

    expect(data).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. review_assets
// ─────────────────────────────────────────────────────────────────────
describe("review_assets_select_public", () => {
  it("allows seeing review asset on published repo", async () => {
    const { userId } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, userId);

    await svc.from("review_assets").insert({
      review_id: review.id,
      storage_key: `${userId}/${review.id}/0.png`,
      content_type: "image/png",
      ordering: 0,
    });

    const { client } = await createTestUser();

    const { data, error } = await client
      .from("review_assets")
      .select("id")
      .eq("review_id", review.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("denies seeing review asset on removed repo", async () => {
    const { userId } = await createTestUser();
    const repo = await createRepo("removed");
    const review = await createReview(repo.id, userId);

    await svc.from("review_assets").insert({
      review_id: review.id,
      storage_key: `${userId}/${review.id}/0.png`,
      content_type: "image/png",
      ordering: 0,
    });

    const { client } = await createTestUser();

    const { data } = await client.from("review_assets").select("id").eq("review_id", review.id);

    expect(data).toHaveLength(0);
  });
});

describe("review_assets_insert_own", () => {
  it("allows user to insert asset on own review", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, userId);

    const { error } = await client.from("review_assets").insert({
      review_id: review.id,
      storage_key: `${userId}/${review.id}/0.png`,
      content_type: "image/png",
      ordering: 0,
    });

    expect(error).toBeNull();
  });

  it("denies user inserting asset on another user's review", async () => {
    const { userId: ownerUserId } = await createTestUser();
    const { client: otherClient } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, ownerUserId);

    const { error } = await otherClient.from("review_assets").insert({
      review_id: review.id,
      storage_key: `${ownerUserId}/${review.id}/0.png`,
      content_type: "image/png",
      ordering: 0,
    });

    expect(error).not.toBeNull();
  });
});

describe("review_assets_delete_own", () => {
  // NOTE: Deleting review_assets rows fires the cleanup_storage_object_on_asset_delete
  // trigger (migration 000012), which does DELETE FROM storage.objects. When the local
  // storage service is unavailable, this trigger may error. We test the RLS policy
  // (USING predicate) by verifying the delete attempt is at least authorized for the
  // owner vs rejected for non-owners. The actual row deletion depends on the storage
  // trigger succeeding (which requires the storage service).

  it("allows user to delete asset from own review (policy check)", async () => {
    const { userId, client } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, userId);

    const { data: asset } = await svc
      .from("review_assets")
      .insert({
        review_id: review.id,
        storage_key: `${userId}/${review.id}/0.png`,
        content_type: "image/png",
        ordering: 0,
      })
      .select("id")
      .single();

    const { error } = await client.from("review_assets").delete().eq("id", asset!.id);

    // If storage service is running, this succeeds cleanly (error is null).
    // If storage service is unavailable, the cleanup trigger fails with 42501.
    // In either case, the RLS policy itself allowed the delete — the error (if any)
    // comes from the trigger, not from RLS. We verify:
    if (error) {
      // The error must be from the storage cleanup trigger, not RLS denial
      expect(error.message).toContain("storage");
    } else {
      // Full success — verify row is gone
      const { data } = await svc.from("review_assets").select("id").eq("id", asset!.id);

      expect(data).toHaveLength(0);
    }
  });

  it("denies user deleting asset from another user's review", async () => {
    const { userId: ownerUserId } = await createTestUser();
    const { client: otherClient } = await createTestUser();
    const repo = await createRepo("published");
    const review = await createReview(repo.id, ownerUserId);

    const { data: asset } = await svc
      .from("review_assets")
      .insert({
        review_id: review.id,
        storage_key: `${ownerUserId}/${review.id}/0.png`,
        content_type: "image/png",
        ordering: 0,
      })
      .select("id")
      .single();

    await otherClient.from("review_assets").delete().eq("id", asset!.id);

    // Verify NOT deleted (RLS blocks the delete silently — 0 rows affected)
    const { data } = await svc.from("review_assets").select("id").eq("id", asset!.id);

    expect(data).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. pipeline_runs — deny-all for authenticated
// ─────────────────────────────────────────────────────────────────────
describe("pipeline_runs (deny-all)", () => {
  it("allows service role to select", async () => {
    const { data, error } = await svc.from("pipeline_runs").select("id").limit(1);

    expect(error).toBeNull();
    expect(data).toBeDefined();
  });

  it("denies authenticated user select", async () => {
    // Insert a row via service so there's data
    await svc.from("pipeline_runs").insert({
      job_name: "test-deny",
      status: "success",
    });

    const { client } = await createTestUser();

    const { data } = await client.from("pipeline_runs").select("id").limit(10);

    expect(data).toHaveLength(0);
  });
});
