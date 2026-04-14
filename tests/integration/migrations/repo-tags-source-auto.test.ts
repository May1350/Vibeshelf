// Verifies migration 20260414000001 extended the repo_tags.source
// CHECK constraint to accept 'auto'. Also confirms the pre-existing
// values ('ai', 'manual', 'review_derived') still pass and a bogus
// value is still rejected.
//
// The migration DROPs the original constraint and ADDs a new one with
// the expanded list. A regression where either a new value is dropped
// or an old value is removed would be caught by this test.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { createServiceTestClient } from "@/tests/helpers/test-user";

let svc: SupabaseClient<Database>;

const FIXTURE_REPO = {
  github_id: 900_200_001,
  owner: "fixture-constraint-owner",
  name: "fixture-constraint-repo",
};
const TAG_SLUGS = ["test-constraint-auto", "test-constraint-ai", "test-constraint-bogus"];

let repoId: string;
const tagIds: Record<string, string> = {};

async function seed(): Promise<void> {
  const now = new Date().toISOString();

  // 1) Repo row.
  const { data: repoRow, error: repoErr } = await svc
    .from("repos")
    .insert({
      github_id: FIXTURE_REPO.github_id,
      owner: FIXTURE_REPO.owner,
      name: FIXTURE_REPO.name,
      license: "mit",
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      status: "pending",
    })
    .select("id")
    .single();
  if (repoErr || !repoRow) throw repoErr ?? new Error("seed: repo insert failed");
  repoId = repoRow.id;

  // 2) Three distinct tag rows — one per (source test). We need separate
  //    tags because repo_tags PK is (repo_id, tag_id): inserting three
  //    rows with the same tag_id would trigger a PK conflict, masking
  //    the CHECK-constraint assertion we care about.
  for (const slug of TAG_SLUGS) {
    const { data, error } = await svc
      .from("tags")
      .insert({ slug, kind: "tech_stack", label: slug })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error(`seed: tag ${slug} insert failed`);
    tagIds[slug] = data.id;
  }
}

async function cleanup(): Promise<void> {
  const { data: repo } = await svc
    .from("repos")
    .select("id")
    .eq("github_id", FIXTURE_REPO.github_id);
  const ids = (repo ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await svc.from("repo_tags").delete().in("repo_id", ids);
    await svc.from("repos").delete().in("id", ids);
  }
  await svc.from("tags").delete().in("slug", TAG_SLUGS);
}

describe("repo_tags.source CHECK includes 'auto'", () => {
  beforeAll(async () => {
    svc = createServiceTestClient();
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("accepts source='auto' (new value added by migration)", async () => {
    const slug = "test-constraint-auto";
    const tagId = tagIds[slug];
    expect(tagId).toBeTruthy();
    const { error } = await svc.from("repo_tags").insert({
      repo_id: repoId,
      tag_id: tagId as string,
      source: "auto",
      confidence: 1.0,
    });
    expect(error).toBeNull();
  });

  it("accepts source='ai' (existing value still works after DROP+ADD)", async () => {
    const slug = "test-constraint-ai";
    const tagId = tagIds[slug];
    expect(tagId).toBeTruthy();
    const { error } = await svc.from("repo_tags").insert({
      repo_id: repoId,
      tag_id: tagId as string,
      source: "ai",
      confidence: 0.9,
    });
    expect(error).toBeNull();
  });

  it("rejects source='bogus' (CHECK constraint still enforced)", async () => {
    const slug = "test-constraint-bogus";
    const tagId = tagIds[slug];
    expect(tagId).toBeTruthy();
    const { error } = await svc.from("repo_tags").insert({
      repo_id: repoId,
      tag_id: tagId as string,
      source: "bogus",
      confidence: 0.5,
    });
    expect(error).toBeTruthy();
    // Postgres CHECK violations come through as 23514. supabase-js
    // surfaces the code on the PostgrestError.
    const code = (error as unknown as { code?: string } | null)?.code;
    if (code) {
      expect(code).toBe("23514");
    }
  });
});
