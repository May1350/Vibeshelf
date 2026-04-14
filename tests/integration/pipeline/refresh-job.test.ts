// Integration test for refreshJob — covers the three drift scenarios:
//   Case A: readme_sha unchanged → repo stays 'published', stars bump
//   Case B: GitHub 404 on repo fetch → repo flips to 'removed'
//   Case C: license changed from 'mit' to 'gpl-3.0' → repo flips to 'removed'
//
// We run each case independently: seed exactly one fixture repo, mount
// a case-specific fetch mock, call refreshJob, assert, clean up. Keeping
// them separate avoids refresh's batch cursor advancing over a repo
// another case still needs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@/lib/crypto/tokens";
import type { Database } from "@/lib/db/database.types";
import { refreshJob } from "@/lib/pipeline/jobs/refresh";
import { runJob } from "@/lib/pipeline/runJob";
import { createServiceTestClient } from "@/tests/helpers/test-user";

let svc: SupabaseClient<Database>;

const TEST_LABEL = "test-refresh-token";
const FIXTURE_REPO = {
  github_id: 900_100_001,
  owner: "fixture-refresh-owner",
  name: "fixture-refresh-repo",
};

function rateLimitHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-RateLimit-Remaining": "4999",
    "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: rateLimitHeaders() });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ message: "Not Found" }), {
    status: 404,
    headers: rateLimitHeaders(),
  });
}

/**
 * Build a fetch mock tuned for a particular case. The refresh job makes
 * two kinds of calls:
 *   GET /repos/{owner}/{name}             — core metadata + license
 *   GET /repos/{owner}/{name}/readme      — sha drift check
 */
interface MockCase {
  repoStatus: number; // 200 or 404
  licenseSpdx: string | null;
  stars: number;
  readmeSha: string | null; // null → 404 on readme endpoint
}

function makeMockFetch(c: MockCase) {
  return function mockFetch(input: RequestInfo | URL): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Repo metadata
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      if (c.repoStatus === 404) return Promise.resolve(notFoundResponse());
      return Promise.resolve(
        jsonResponse({
          id: FIXTURE_REPO.github_id,
          full_name: `${FIXTURE_REPO.owner}/${FIXTURE_REPO.name}`,
          name: FIXTURE_REPO.name,
          description: "refreshed",
          homepage: null,
          license: c.licenseSpdx ? { spdx_id: c.licenseSpdx } : null,
          default_branch: "main",
          stargazers_count: c.stars,
          forks_count: 0,
          watchers_count: 0,
          pushed_at: "2026-04-10T00:00:00Z",
          owner: { login: FIXTURE_REPO.owner },
        }),
      );
    }

    // README sha lookup
    if (/\/repos\/[^/]+\/[^/]+\/readme$/.test(url)) {
      if (c.readmeSha === null) return Promise.resolve(notFoundResponse());
      return Promise.resolve(jsonResponse({ sha: c.readmeSha }));
    }

    return Promise.reject(new Error(`mockFetch: unhandled URL ${url}`));
  };
}

async function seedToken(): Promise<void> {
  const toHex = (buf: Buffer): string => `\\x${buf.toString("hex")}`;
  await svc.from("github_tokens").insert({
    label: TEST_LABEL,
    scope: "rest",
    token_encrypted: toHex(encryptToken("ghp_refresh_fixture", 1)),
    token_key_version: 1,
    remaining: 5000,
    reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

async function seedRepo(opts: { license: string; readmeSha: string | null }): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await svc
    .from("repos")
    .insert({
      github_id: FIXTURE_REPO.github_id,
      owner: FIXTURE_REPO.owner,
      name: FIXTURE_REPO.name,
      license: opts.license,
      default_branch: "main",
      stars: 10,
      forks: 0,
      watchers: 0,
      last_commit_at: now,
      github_created_at: now,
      github_pushed_at: now,
      readme_sha: opts.readmeSha,
      status: "published",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedRepo failed");
  return data.id;
}

async function cleanupRepo(): Promise<void> {
  const { data: repos } = await svc
    .from("repos")
    .select("id")
    .eq("github_id", FIXTURE_REPO.github_id);
  const ids = (repos ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await svc.from("repo_tags").delete().in("repo_id", ids);
    await svc.from("repo_assets").delete().in("repo_id", ids);
    await svc.from("repos").delete().in("id", ids);
  }
  await svc.from("pipeline_runs").delete().eq("job_name", "test-refresh");
}

describe("refreshJob (integration)", () => {
  beforeAll(async () => {
    svc = createServiceTestClient();
    await cleanupRepo();
    await svc.from("github_tokens").delete().eq("label", TEST_LABEL);
    await seedToken();
  });

  afterAll(async () => {
    await cleanupRepo();
    await svc.from("github_tokens").delete().eq("label", TEST_LABEL);
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    // Each case owns its mock. Unstub between cases so a leaked mock
    // never silently applies to the next one.
    vi.unstubAllGlobals();
    await cleanupRepo();
  });

  it("Case A: readme_sha unchanged → status stays published, stars updated", async () => {
    const repoId = await seedRepo({ license: "mit", readmeSha: "old-sha" });
    vi.stubGlobal(
      "fetch",
      makeMockFetch({ repoStatus: 200, licenseSpdx: "MIT", stars: 11, readmeSha: "old-sha" }),
    );

    await runJob("test-refresh", {}, (ctx) => refreshJob(ctx, { batchSize: 10 }));

    const { data: after } = await svc
      .from("repos")
      .select("status, stars, readme_sha")
      .eq("id", repoId)
      .single();

    expect(after?.status).toBe("published");
    expect(after?.stars).toBe(11);
    expect(after?.readme_sha).toBe("old-sha");
  });

  it("Case B: 404 on repo fetch → status flips to 'removed'", async () => {
    const repoId = await seedRepo({ license: "mit", readmeSha: "old-sha" });
    vi.stubGlobal(
      "fetch",
      makeMockFetch({ repoStatus: 404, licenseSpdx: null, stars: 0, readmeSha: null }),
    );

    await runJob("test-refresh", {}, (ctx) => refreshJob(ctx, { batchSize: 10 }));

    const { data: after } = await svc.from("repos").select("status").eq("id", repoId).single();

    expect(after?.status).toBe("removed");
  });

  it("Case C: license changes from 'mit' to 'gpl-3.0' → status flips to 'removed'", async () => {
    const repoId = await seedRepo({ license: "mit", readmeSha: "old-sha" });
    vi.stubGlobal(
      "fetch",
      // Non-permissive license returned; refresh should mark the repo removed
      // before touching the readme endpoint.
      makeMockFetch({ repoStatus: 200, licenseSpdx: "GPL-3.0", stars: 12, readmeSha: "old-sha" }),
    );

    await runJob("test-refresh", {}, (ctx) => refreshJob(ctx, { batchSize: 10 }));

    const { data: after } = await svc.from("repos").select("status").eq("id", repoId).single();

    expect(after?.status).toBe("removed");
  });
});
