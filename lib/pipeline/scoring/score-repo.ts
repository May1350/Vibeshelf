// Score a single repo: fetch README → deterministic + Gemini scores →
// apply_score_result RPC. Called from both score.ts (first-time) and
// rescore.ts (monthly) with is_rescore flag.

import type { SupabaseClient } from "@/lib/db";
import { extractReadmeSections } from "@/lib/pipeline/extractors/readme-sections";
import type { GeminiClient } from "@/lib/pipeline/gemini/client";
import { GeminiContentFilterError, SchemaValidationError } from "@/lib/pipeline/gemini/errors";
import { buildScoringPrompt, SCORING_MODEL } from "@/lib/pipeline/gemini/scoring-prompt";
import { githubFetch } from "@/lib/pipeline/github/client";
import { NotFoundError, PermissionError } from "@/lib/pipeline/github/errors";
import { resolveTagIds } from "@/lib/pipeline/tags/resolve";
import type { JobContext } from "@/lib/types/jobs";
import { computeDeterministicScores } from "./deterministic";
import type { RequestBudget } from "./request-budget";
import { normalizeTags } from "./tag-normalizer";

export interface ClaimedRepo {
  id: string;
  github_id: number;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  license: string | null;
  default_branch: string;
  stars: number;
  forks: number;
  watchers: number;
  last_commit_at: string;
  github_created_at: string;
  github_pushed_at: string;
  readme_sha: string | null;
  capabilities: {
    has_package_json?: boolean;
    has_readme?: boolean;
    vibecoding_tools?: string[];
    tech_stack_slugs?: string[];
  };
  assets_extracted_at: string | null;
}

export type ScoreOutcome =
  | { status: "published" | "scored" | "needs_review" }
  | { status: "skipped"; reason: "schema_error" | "server_error" | "readme_fetch" };

interface ScoreRepoDeps {
  gemini: GeminiClient;
  budget: RequestBudget;
  isRescore: boolean;
}

export async function scoreRepo(
  ctx: JobContext,
  repo: ClaimedRepo,
  deps: ScoreRepoDeps,
): Promise<ScoreOutcome> {
  // 1. Load README (if present) + file tree + package.json
  let readmeContent = "";
  if (repo.capabilities.has_readme !== false) {
    try {
      readmeContent = await fetchReadme(ctx.db, repo.owner, repo.name);
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof PermissionError) {
        readmeContent = ""; // treat as no-readme path
      } else {
        return { status: "skipped", reason: "readme_fetch" };
      }
    }
  }

  const fileTree = await fetchFileTree(ctx.db, repo);
  const packageJsonContent = await fetchPackageJsonIfPresent(ctx.db, repo);
  const repoAssetCount = await countAssets(ctx.db, repo.id);

  // 2. Deterministic scores
  const det = computeDeterministicScores({
    stars: repo.stars,
    forks: repo.forks,
    watchers: repo.watchers,
    githubCreatedAt: new Date(repo.github_created_at),
    lastCommitAt: new Date(repo.last_commit_at),
    capabilities: repo.capabilities,
    fileTree,
    packageJsonContent,
    repoAssetCount,
    assetsExtractedAt: repo.assets_extracted_at ? new Date(repo.assets_extracted_at) : null,
  });

  // 3. Gemini call
  const sections = readmeContent
    ? extractReadmeSections(readmeContent)
    : { content: "", structured: false };
  const prompt = buildScoringPrompt({
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    stars: repo.stars,
    lastCommitIso: repo.last_commit_at,
    license: repo.license,
    techStackSlugs: repo.capabilities.tech_stack_slugs ?? [],
    vibecodingToolSlugs: repo.capabilities.vibecoding_tools ?? [],
    hasReadme: Boolean(readmeContent),
    hasPackageJson: Boolean(packageJsonContent),
    readmeSections: sections.content,
  });

  let llmResult: LlmScores;
  try {
    const response = await deps.gemini.score(
      {
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        responseSchema: prompt.responseSchema,
        model: SCORING_MODEL,
      },
      deps.budget,
    );
    llmResult = parseLlmResponse(response.data);
  } catch (err) {
    if (err instanceof GeminiContentFilterError) {
      // Route to needs_review via apply_score_result with weak evidence
      await applyWithWeakEvidence(ctx, repo, det, deps.isRescore, prompt.version);
      return { status: "needs_review" };
    }
    if (err instanceof SchemaValidationError) {
      return { status: "skipped", reason: "schema_error" };
    }
    // Server/rate-limit: let caller decide (they bubble up or halt)
    throw err;
  }

  // 4. Merge code_health (det 60% + llm 40%) + build canonical tag inputs
  const mergedCodeHealth =
    det.code_health_score_deterministic * 0.6 + llmResult.codeHealthReadme * 0.4;

  const { canonical, freeform } = normalizeTags(llmResult.canonicalTags, llmResult.novelTags);

  // Resolve canonical slugs → tag row IDs. This upserts missing tag rows
  // BUT does NOT insert repo_tags junction — apply_score_result RPC does
  // that atomically with the score write. Orphaned tag rows if the RPC
  // fails are harmless (just unused lookup rows).
  const resolvedTags = await resolveTagIds(
    ctx.db,
    canonical.map((slug) => ({
      slug,
      kind: "feature" as const,
      confidence: 0.8,
      source: "auto_llm" as const,
    })),
  );
  const canonicalTagIds = resolvedTags.map((r) => r.id);
  const canonicalConfidences = resolvedTags.map((r) => r.confidence);

  // 5. apply_score_result RPC
  const { data: statusResult, error: rpcErr } = await ctx.db.rpc("apply_score_result", {
    p_repo_id: repo.id,
    p_documentation_score: llmResult.documentation,
    p_code_health_score: mergedCodeHealth,
    p_maintenance_score: det.maintenance_score,
    p_popularity_score: det.popularity_score,
    p_visual_preview_score: det.visual_preview_score,
    p_category: llmResult.category,
    p_canonical_tag_ids: canonicalTagIds,
    p_canonical_confidences: canonicalConfidences,
    p_freeform_tags: freeform,
    p_rationale: {
      documentation: llmResult.documentationRationale,
      code_health_readme: llmResult.codeHealthRationale,
    },
    p_evidence_strength: llmResult.evidenceStrength,
    p_prompt_version: prompt.version,
    p_model: SCORING_MODEL,
    p_run_id: ctx.runId,
    p_is_rescore: deps.isRescore,
  });

  if (rpcErr) throw new Error(`apply_score_result failed: ${rpcErr.message}`);

  return { status: (statusResult as "published" | "scored" | "needs_review") ?? "scored" };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (DB + GitHub fetches + type narrowing)
// ─────────────────────────────────────────────────────────────────────

interface LlmScores {
  documentation: number;
  documentationRationale: string;
  codeHealthReadme: number;
  codeHealthRationale: string;
  category:
    | "saas"
    | "ecommerce"
    | "dashboard"
    | "landing_page"
    | "ai_tool"
    | "utility"
    | "game"
    | "portfolio"
    | "blog"
    | "chatbot"
    | "mobile_app"
    | "other";
  canonicalTags: readonly string[];
  novelTags: readonly string[];
  evidenceStrength: "strong" | "partial" | "weak";
}

function parseLlmResponse(data: unknown): LlmScores {
  if (typeof data !== "object" || data === null) {
    throw new SchemaValidationError("response not an object", data);
  }
  const d = data as {
    documentation?: { value?: unknown; rationale?: unknown };
    code_health_readme?: { value?: unknown; rationale?: unknown };
    category?: unknown;
    feature_tags_canonical?: unknown;
    feature_tags_novel?: unknown;
    evidence_strength?: unknown;
  };

  const documentation = d.documentation?.value;
  const documentationRationale = d.documentation?.rationale;
  const codeHealthReadme = d.code_health_readme?.value;
  const codeHealthRationale = d.code_health_readme?.rationale;

  if (
    typeof documentation !== "number" ||
    typeof documentationRationale !== "string" ||
    typeof codeHealthReadme !== "number" ||
    typeof codeHealthRationale !== "string" ||
    typeof d.category !== "string" ||
    typeof d.evidence_strength !== "string"
  ) {
    throw new SchemaValidationError("response shape mismatch", data);
  }

  return {
    documentation,
    documentationRationale,
    codeHealthReadme,
    codeHealthRationale,
    category: d.category as LlmScores["category"],
    canonicalTags: Array.isArray(d.feature_tags_canonical)
      ? (d.feature_tags_canonical as readonly string[])
      : [],
    novelTags: Array.isArray(d.feature_tags_novel)
      ? (d.feature_tags_novel as readonly string[])
      : [],
    evidenceStrength: d.evidence_strength as LlmScores["evidenceStrength"],
  };
}

async function fetchReadme(db: SupabaseClient, owner: string, repo: string): Promise<string> {
  const { data } = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    { scope: "rest" },
    db,
  );
  const payload = data as { content?: string; encoding?: string } | null;
  if (!payload?.content) return "";
  const clean = payload.content.replace(/\n/g, "");
  return Buffer.from(clean, "base64").toString("utf-8");
}

async function fetchFileTree(
  db: SupabaseClient,
  repo: ClaimedRepo,
): Promise<{ path: string; type: "file" | "dir" }[]> {
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(repo.default_branch)}`,
      { scope: "rest" },
      db,
    );
    const payload = data as { tree?: { path: string; type: string }[] } | null;
    if (!payload?.tree) return [];
    return payload.tree
      .filter((e) => typeof e.path === "string")
      .map((e) => ({ path: e.path, type: e.type === "tree" ? "dir" : "file" }));
  } catch {
    return [];
  }
}

async function fetchPackageJsonIfPresent(
  db: SupabaseClient,
  repo: ClaimedRepo,
): Promise<string | null> {
  if (repo.capabilities.has_package_json !== true) return null;
  try {
    const { data } = await githubFetch(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/package.json`,
      { scope: "rest" },
      db,
    );
    const payload = data as { content?: string } | null;
    if (!payload?.content) return null;
    return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function countAssets(
  db: SupabaseClient,
  repoId: string,
): Promise<{ gif: number; image: number }> {
  const { data } = await db.from("repo_assets").select("kind").eq("repo_id", repoId);
  const counts = { gif: 0, image: 0 };
  for (const row of data ?? []) {
    if (row.kind === "readme_gif") counts.gif += 1;
    else if (row.kind === "readme_image") counts.image += 1;
  }
  return counts;
}

async function applyWithWeakEvidence(
  ctx: JobContext,
  repo: ClaimedRepo,
  det: ReturnType<typeof computeDeterministicScores>,
  isRescore: boolean,
  promptVersion: string,
): Promise<void> {
  const { error } = await ctx.db.rpc("apply_score_result", {
    p_repo_id: repo.id,
    p_documentation_score: 1,
    p_code_health_score: det.code_health_score_deterministic,
    p_maintenance_score: det.maintenance_score,
    p_popularity_score: det.popularity_score,
    p_visual_preview_score: det.visual_preview_score,
    p_category: "other",
    p_canonical_tag_ids: [],
    p_canonical_confidences: [],
    p_freeform_tags: [],
    p_rationale: { content_filter: true },
    p_evidence_strength: "weak",
    p_prompt_version: promptVersion,
    p_model: SCORING_MODEL,
    p_run_id: ctx.runId,
    p_is_rescore: isRescore,
  });
  if (error) throw new Error(`apply_score_result (weak) failed: ${error.message}`);
}
