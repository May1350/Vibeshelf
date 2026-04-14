// Integration test for discoverJob.
//
// Strategy: real Supabase DB + mocked global fetch. We stub fetch with
// vi.stubGlobal so every HTTP call issued by lib/pipeline/github/client.ts
// routes through our in-memory router. Canned responses cover the four
// GitHub endpoints discoverJob touches:
//   - /search/repositories
//   - /repos/{owner}/{name}/readme
//   - /repos/{owner}/{name}/git/trees/{branch}
//   - /repos/{owner}/{name}/contents/package.json
//
// After running the job we assert on the DB side-effects:
//   - pipeline_runs row with status='success'
//   - repos rows for the mocked search results
//   - repo_tags with source='auto' (nextjs comes from the mocked package.json)
//   - repo_assets pointing at the image URL embedded in the mocked README

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@/lib/crypto/tokens";
import type { Database } from "@/lib/db/database.types";
import { discoverJob } from "@/lib/pipeline/jobs/discover";
import { runJob } from "@/lib/pipeline/runJob";
import { createServiceTestClient } from "@/tests/helpers/test-user";

let svc: SupabaseClient<Database>;

const TEST_LABEL_PREFIX = "test-discover";

// github_ids we seed into the mocked search response. Kept in a high
// bigint range to avoid colliding with any real-world fixtures in the
// DB.
const FIXTURE_REPO_A = {
  id: 900_000_001,
  owner: "fixture-owner-a",
  name: "fixture-repo-a",
};
const FIXTURE_REPO_B = {
  id: 900_000_002,
  owner: "fixture-owner-b",
  name: "fixture-repo-b",
};

const FIXTURE_README = `# Fixture Repo

![screenshot](https://user-images.githubusercontent.com/1/fixture-screenshot.png)
`;

const FIXTURE_PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: { next: "14.0.0" },
});

function toBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Keep the token pool happy: any positive remaining + a far-future
      // reset means we never trigger the sleep/throw paths.
      "X-RateLimit-Remaining": "4999",
      "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
    },
    ...init,
  });
}

// Router that maps GitHub API URLs → canned responses. Any unmatched
// URL blows up so a regression is loud rather than silently returning {}.
function mockFetch(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (url.startsWith("https://api.github.com/search/repositories")) {
    return Promise.resolve(
      jsonResponse({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            id: FIXTURE_REPO_A.id,
            name: FIXTURE_REPO_A.name,
            full_name: `${FIXTURE_REPO_A.owner}/${FIXTURE_REPO_A.name}`,
            owner: { login: FIXTURE_REPO_A.owner },
            description: "fixture A",
            homepage: null,
            license: { spdx_id: "MIT" },
            stargazers_count: 42,
            forks_count: 1,
            watchers_count: 3,
            default_branch: "main",
            pushed_at: "2026-04-01T00:00:00Z",
            created_at: "2025-01-01T00:00:00Z",
          },
          {
            id: FIXTURE_REPO_B.id,
            name: FIXTURE_REPO_B.name,
            full_name: `${FIXTURE_REPO_B.owner}/${FIXTURE_REPO_B.name}`,
            owner: { login: FIXTURE_REPO_B.owner },
            description: "fixture B",
            homepage: null,
            license: { spdx_id: "MIT" },
            stargazers_count: 99,
            forks_count: 5,
            watchers_count: 11,
            default_branch: "main",
            pushed_at: "2026-04-02T00:00:00Z",
            created_at: "2025-02-01T00:00:00Z",
          },
        ],
      }),
    );
  }

  // README content — base64-encoded payload matching GitHub's response shape.
  if (/\/repos\/[^/]+\/[^/]+\/readme$/.test(url)) {
    return Promise.resolve(
      jsonResponse({
        content: toBase64(FIXTURE_README),
        sha: "fixture-readme-sha",
        encoding: "base64",
      }),
    );
  }

  // File tree — includes package.json so the extractor fetches it.
  if (/\/repos\/[^/]+\/[^/]+\/git\/trees\/main$/.test(url)) {
    return Promise.resolve(
      jsonResponse({
        tree: [
          { path: "package.json", type: "blob" },
          { path: "README.md", type: "blob" },
        ],
        truncated: false,
      }),
    );
  }

  // package.json contents
  if (/\/repos\/[^/]+\/[^/]+\/contents\/package\.json$/.test(url)) {
    return Promise.resolve(
      jsonResponse({
        content: toBase64(FIXTURE_PACKAGE_JSON),
        encoding: "base64",
      }),
    );
  }

  return Promise.reject(new Error(`mockFetch: unhandled URL ${url}`));
}

async function seedToken(): Promise<void> {
  const toHex = (buf: Buffer): string => `\\x${buf.toString("hex")}`;
  await svc.from("github_tokens").insert([
    {
      label: `${TEST_LABEL_PREFIX}-rest`,
      scope: "rest",
      token_encrypted: toHex(encryptToken("ghp_fixture_rest", 1)),
      token_key_version: 1,
      remaining: 5000,
      reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    {
      label: `${TEST_LABEL_PREFIX}-search`,
      scope: "search",
      token_encrypted: toHex(encryptToken("ghp_fixture_search", 1)),
      token_key_version: 1,
      remaining: 30,
      reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  ]);
}

async function cleanup(): Promise<void> {
  // Order matters: repo_tags/repo_assets reference repos; repos have no
  // children beyond those that cascade. We delete by github_id range.
  const { data: repos } = await svc
    .from("repos")
    .select("id")
    .in("github_id", [FIXTURE_REPO_A.id, FIXTURE_REPO_B.id]);
  const ids = (repos ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await svc.from("repo_tags").delete().in("repo_id", ids);
    await svc.from("repo_assets").delete().in("repo_id", ids);
    await svc.from("repos").delete().in("id", ids);
  }
  await svc.from("github_tokens").delete().like("label", `${TEST_LABEL_PREFIX}-%`);
  await svc.from("pipeline_runs").delete().eq("job_name", "test-discover");
  // Tags the extractor may have created — only delete the canonical
  // ones this test could have added.
  await svc.from("tags").delete().in("slug", ["nextjs"]);
}

describe("discoverJob (integration)", () => {
  beforeAll(async () => {
    svc = createServiceTestClient();
    vi.stubGlobal("fetch", mockFetch);
    await cleanup();
    await seedToken();
  });

  afterAll(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("discovers mocked repos, writes tags + assets, records pipeline_runs=success", async () => {
    const result = await runJob("test-discover", {}, (ctx) => discoverJob(ctx, { maxQueries: 1 }));

    // Top-level job output.
    expect(result.lock_acquired).toBe(true);
    expect(result.queries_executed).toBeGreaterThanOrEqual(1);
    expect(result.repos_discovered).toBeGreaterThanOrEqual(2);

    // pipeline_runs row.
    const { data: runs } = await svc
      .from("pipeline_runs")
      .select("status, metrics")
      .eq("job_name", "test-discover")
      .order("started_at", { ascending: false })
      .limit(1);
    expect(runs?.[0]?.status).toBe("success");

    // repos — our two fixtures should now be in the table with status='pending'.
    const { data: repos } = await svc
      .from("repos")
      .select("id, github_id, status, readme_sha, capabilities")
      .in("github_id", [FIXTURE_REPO_A.id, FIXTURE_REPO_B.id]);
    expect(repos).toHaveLength(2);
    for (const r of repos ?? []) {
      expect(r.status).toBe("pending");
      expect(r.readme_sha).toBe("fixture-readme-sha");
    }

    // repo_tags — at least one row with source='auto' (nextjs tag from package.json).
    const repoIds = (repos ?? []).map((r) => r.id);
    const { data: tagRows } = await svc
      .from("repo_tags")
      .select("source, tag_id")
      .in("repo_id", repoIds);
    expect(tagRows?.length ?? 0).toBeGreaterThan(0);
    expect(tagRows?.some((t) => t.source === "auto")).toBe(true);

    // Confirm the nextjs tag itself was created.
    const { data: tags } = await svc.from("tags").select("slug, kind").eq("slug", "nextjs");
    expect(tags?.[0]?.slug).toBe("nextjs");
    expect(tags?.[0]?.kind).toBe("tech_stack");

    // repo_assets — one row per repo for the README screenshot.
    const { data: assets } = await svc
      .from("repo_assets")
      .select("repo_id, external_url, kind")
      .in("repo_id", repoIds);
    expect(assets?.length ?? 0).toBeGreaterThan(0);
    expect(assets?.[0]?.external_url).toContain("fixture-screenshot.png");
    expect(assets?.[0]?.kind).toBe("readme_image");
  });
});
