// Per-repo detail fetches: README, shallow file tree, package.json.
//
// Called by the discover job after a search batch to gather the
// ingredients extractors need (tech-stack parses package.json;
// readme-media parses README; vibecoding-compat inspects the file
// tree). This module makes 1-3 HTTP calls per repo and uses a worker
// pool to cap fan-out.
//
// Error philosophy:
//   - Per-repo errors (404, 451, 403-permission, 422, 5xx) are caught
//     and converted into a structured "skipped" outcome, so a single
//     bad repo doesn't abort the batch.
//   - Rate-limit / pool-exhaustion / token-revoked errors PROPAGATE —
//     if we can't talk to GitHub at all, retrying more repos will just
//     burn time. Let the caller halt and schedule a retry.
//
// Framework-free: no next/*, react, or @supabase/supabase-js imports.

import type { SupabaseClient } from "@/lib/db";
import { githubFetch } from "./client";
import {
  LegallyUnavailableError,
  NotFoundError,
  PermissionError,
  PoolExhaustedError,
  RateLimitError,
  RateLimitExhaustedError,
  ServerError,
  TokenRevokedError,
  ValidationError,
} from "./errors";

export interface RepoDetails {
  readme: {
    content: string; // decoded markdown
    sha: string; // for change detection
  } | null;
  fileTree: Array<{ path: string; type: "file" | "dir" }>;
  packageJson: string | null; // raw JSON text, if package.json exists at root
}

export interface FetchRepoDetailsResult {
  details: RepoDetails;
  skipped: false;
}

export interface SkippedRepoDetails {
  skipped: true;
  reason: "not_found" | "legally_unavailable" | "permission" | "server_error";
}

const DEFAULT_CONCURRENCY = 5;

/**
 * Fetch README + file tree + package.json for a single repo.
 *
 * README and package.json are treated as optional (missing → null in
 * the result). The file tree is treated as optional too (empty array
 * on NotFound) because some repos have an empty default branch tip
 * (e.g. freshly-created mirror repos).
 *
 * If the *repo itself* 404s on the file-tree call, we skip with
 * 'not_found' — that endpoint is the most reliable proxy for "repo
 * exists and we can see it".
 */
export async function fetchRepoDetails(
  db: SupabaseClient,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<FetchRepoDetailsResult | SkippedRepoDetails> {
  // Order: tree → readme → package.json. Tree first so a 404/451 on
  // the repo itself fails fast without burning two extra calls.
  let fileTree: RepoDetails["fileTree"];
  try {
    fileTree = await fetchFileTree(db, owner, repo, defaultBranch);
  } catch (err) {
    const skip = classifyRepoError(err);
    if (skip) return skip;
    throw err;
  }

  let readme: RepoDetails["readme"];
  try {
    readme = await fetchReadme(db, owner, repo);
  } catch (err) {
    const skip = classifyRepoError(err);
    if (skip) return skip;
    throw err;
  }

  let packageJson: RepoDetails["packageJson"];
  try {
    packageJson = await fetchPackageJson(db, owner, repo);
  } catch (err) {
    const skip = classifyRepoError(err);
    if (skip) return skip;
    throw err;
  }

  return {
    skipped: false,
    details: { readme, fileTree, packageJson },
  };
}

/**
 * Fetch details for many repos with a bounded worker pool. Keyed by
 * `${owner}/${name}` in the returned Map — callers are expected to
 * have already deduped input, but we'd just overwrite on collision.
 *
 * Abort model: if any worker throws (e.g. `RateLimitError`,
 * `PoolExhaustedError`, `TokenRevokedError`), the shared abort flag
 * stops remaining workers from pulling new items. In-flight requests
 * can't be cancelled, but they won't start new ones. The first error
 * is rethrown out of `Promise.all` via `Promise.allSettled`-drain.
 * Any results populated before the abort remain in the returned Map
 * for callers that want to process partial batches.
 */
export async function fetchRepoDetailsBatch(
  db: SupabaseClient,
  repos: Array<{ owner: string; name: string; default_branch: string }>,
  opts: { concurrency?: number } = {},
): Promise<Map<string, FetchRepoDetailsResult | SkippedRepoDetails>> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const results = new Map<string, FetchRepoDetailsResult | SkippedRepoDetails>();

  if (repos.length === 0) return results;

  let cursor = 0;
  let abortErr: unknown = null;
  const workerCount = Math.min(concurrency, repos.length);

  const worker = async (): Promise<void> => {
    while (abortErr === null) {
      const index = cursor++;
      if (index >= repos.length) return;
      const repo = repos[index];
      if (!repo) return;

      const key = `${repo.owner}/${repo.name}`;
      try {
        const outcome = await fetchRepoDetails(db, repo.owner, repo.name, repo.default_branch);
        results.set(key, outcome);
      } catch (err) {
        // Record the first error to abort peers; rethrow so
        // allSettled surfaces it to the outer rethrow below.
        if (abortErr === null) abortErr = err;
        throw err;
      }
    }
  };

  const workers = Array.from({ length: workerCount }, () => worker());
  // allSettled lets in-flight workers finish without cancelling peers
  // mid-HTTP. The first recorded error (abortErr) is what we rethrow.
  await Promise.allSettled(workers);
  if (abortErr !== null) throw abortErr;

  return results;
}

// ──────────────────────────────────────────────────────────────────────
// Individual endpoint fetchers
// ──────────────────────────────────────────────────────────────────────

interface ReadmeResponse {
  content?: string; // base64
  sha?: string;
  encoding?: string; // usually "base64"
}

async function fetchReadme(
  db: SupabaseClient,
  owner: string,
  repo: string,
): Promise<RepoDetails["readme"]> {
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      { scope: "rest" },
      db,
    );
    const payload = data as ReadmeResponse | null;
    if (!payload || typeof payload.content !== "string" || typeof payload.sha !== "string") {
      return null;
    }
    const content = decodeBase64(payload.content);
    return { content, sha: payload.sha };
  } catch (err) {
    // A repo without a README is common; every other failure is real.
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

interface TreeResponse {
  tree?: Array<{ path?: string; type?: string }>;
  truncated?: boolean;
}

async function fetchFileTree(
  db: SupabaseClient,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<RepoDetails["fileTree"]> {
  const branchRef = encodeURIComponent(defaultBranch);
  // Non-recursive: the `recursive` query param is absent, which the
  // GitHub API treats as false. We only need root-level entries for
  // vibecoding-compat + presence checks; recursing would pull up to
  // 100k entries per repo and blow response-size budgets.
  const { data } = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${branchRef}`,
    { scope: "rest" },
    db,
  );
  const payload = data as TreeResponse | null;
  if (!payload || !Array.isArray(payload.tree)) return [];
  // Defensive metric: if GitHub truncated the tree, downstream
  // extractors might miss root-level markers. Log so ops can spot it.
  if ((payload as { truncated?: boolean }).truncated === true) {
    console.warn(`[repo-details] tree truncated for ${owner}/${repo}`);
  }

  const out: RepoDetails["fileTree"] = [];
  for (const entry of payload.tree) {
    if (typeof entry.path !== "string" || !entry.path) continue;
    if (entry.type === "blob") {
      out.push({ path: entry.path, type: "file" });
    } else if (entry.type === "tree") {
      out.push({ path: entry.path, type: "dir" });
    }
    // commit (submodule) and anything else is intentionally dropped —
    // extractors only care about files and directories at the root.
  }
  return out;
}

interface ContentsResponse {
  content?: string; // base64
  encoding?: string;
}

async function fetchPackageJson(
  db: SupabaseClient,
  owner: string,
  repo: string,
): Promise<RepoDetails["packageJson"]> {
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/package.json`,
      { scope: "rest" },
      db,
    );
    const payload = data as ContentsResponse | null;
    if (!payload || typeof payload.content !== "string") return null;
    return decodeBase64(payload.content);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Error classification
// ──────────────────────────────────────────────────────────────────────

/**
 * Map a per-repo error to a `SkippedRepoDetails` outcome when the
 * error is local to this repo (not a global pipeline-halting
 * condition). Returns null for errors that MUST propagate — the
 * caller rethrows.
 */
function classifyRepoError(err: unknown): SkippedRepoDetails | null {
  // Global halting conditions: if we can't get tokens, skipping and
  // moving on is worse than aborting and retrying later.
  if (err instanceof RateLimitError) return null;
  if (err instanceof RateLimitExhaustedError) return null;
  if (err instanceof PoolExhaustedError) return null;
  if (err instanceof TokenRevokedError) return null;

  // Per-repo, skip-and-continue.
  if (err instanceof NotFoundError) {
    return { skipped: true, reason: "not_found" };
  }
  if (err instanceof LegallyUnavailableError) {
    return { skipped: true, reason: "legally_unavailable" };
  }
  if (err instanceof PermissionError) {
    return { skipped: true, reason: "permission" };
  }
  if (err instanceof ValidationError) {
    // 422 on these endpoints is unusual (they don't take complex
    // params) — lump with permission so upstream metrics can bucket
    // "skipped due to API-level rejection".
    return { skipped: true, reason: "permission" };
  }
  if (err instanceof ServerError) {
    return { skipped: true, reason: "server_error" };
  }

  // Unknown error type → propagate. Better to fail loudly than guess.
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * GitHub base64-encodes file contents with embedded newlines every 60
 * chars. Node's Buffer handles that gracefully; we just strip \n
 * defensively in case the client ever sees a variant encoding.
 */
function decodeBase64(b64: string): string {
  const clean = b64.replace(/\n/g, "");
  return Buffer.from(clean, "base64").toString("utf-8");
}
