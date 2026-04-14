// Computes the 4 deterministic scoring axes from repo metadata + capabilities.
// Pure functions — no DB, no side effects. Results fed into apply_score_result RPC
// alongside Gemini-produced documentation + code_health_readme scores.

export interface DeterministicInput {
  stars: number;
  forks: number;
  watchers: number;
  githubCreatedAt: Date;
  lastCommitAt: Date;
  capabilities: {
    has_package_json?: boolean;
    has_readme?: boolean;
    vibecoding_tools?: readonly string[];
  };
  fileTree: readonly { path: string; type: "file" | "dir" }[];
  packageJsonContent: string | null;
  repoAssetCount: { gif: number; image: number };
  assetsExtractedAt: Date | null;
}

export interface DeterministicScores {
  popularity_score: number; // 0-5
  maintenance_score: number; // 0-5
  code_health_score_deterministic: number; // 0-5, merged with LLM portion later
  visual_preview_score: number; // 0-5
}

export function computeDeterministicScores(input: DeterministicInput): DeterministicScores {
  return {
    popularity_score: computePopularity(input),
    maintenance_score: computeMaintenance(input),
    code_health_score_deterministic: computeCodeHealth(input),
    visual_preview_score: computeVisualPreview(input),
  };
}

// ──────────────────────────────────────────────────────────────────────
// popularity: log(stars+1) / log(months+2) × 2.5, capped at [0, 5]
//
// Examples (cap at 5):
//   1000 stars / 12 months → log(1001)/log(14) × 2.5 ≈ 6.54 → 5.00
//     100 stars / 12 months → log(101)/log(14) × 2.5 ≈ 4.37
//     100 stars / 3 months  → log(101)/log(5) × 2.5 ≈ 7.17 → 5.00
//      10 stars / 12 months → log(11)/log(14) × 2.5 ≈ 2.27
//       0 stars / any       → log(1)/log(...) = 0 → 0.00
//
// The × 2.5 multiplier is calibrated against the ~100 stars / 1 year
// baseline producing a 4.0-ish score (median vibe-coder template). If we
// tune, adjust here and update this comment's worked examples.
// ──────────────────────────────────────────────────────────────────────
function computePopularity(input: DeterministicInput): number {
  const ageMs = Date.now() - input.githubCreatedAt.getTime();
  const months = Math.max(0, ageMs / (1000 * 60 * 60 * 24 * 30));
  // months+2 ensures denominator > 1 even for brand-new repos
  const raw = (Math.log(input.stars + 1) / Math.log(months + 2)) * 2.5;
  return clamp(raw, 0, 5);
}

// ──────────────────────────────────────────────────────────────────────
// maintenance: last_commit freshness (6mo=5, 12mo=3, 24mo=1)
// ──────────────────────────────────────────────────────────────────────
function computeMaintenance(input: DeterministicInput): number {
  const ageMs = Date.now() - input.lastCommitAt.getTime();
  const days = ageMs / (1000 * 60 * 60 * 24);
  if (days <= 180) return 5;
  if (days <= 365) return 3;
  if (days <= 730) return 1;
  return 0;
}

// ──────────────────────────────────────────────────────────────────────
// code_health (deterministic portion): tests presence + dep count
// ──────────────────────────────────────────────────────────────────────
function computeCodeHealth(input: DeterministicInput): number {
  let score = 2; // baseline

  const hasTests = input.fileTree.some(
    (e) =>
      /(^|\/)(tests?|__tests__)\//.test(e.path) ||
      /\.(test|spec)\.[jt]sx?$/.test(e.path) ||
      /^(vitest|jest|playwright)\.config\./.test(e.path),
  );
  if (hasTests) score += 2;

  if (input.capabilities.has_package_json) {
    try {
      const pkg = JSON.parse(input.packageJsonContent ?? "{}");
      const deps = Object.keys(pkg.dependencies ?? {}).length;
      const devDeps = Object.keys(pkg.devDependencies ?? {}).length;
      const total = deps + devDeps;
      // Reasonable range: 10-50. Too few (bare scaffold) or too many (bloat) both reduce.
      if (total >= 10 && total <= 50) score += 1;
    } catch {
      // malformed package.json: no bonus
    }
  }

  return clamp(score, 0, 5);
}

// ──────────────────────────────────────────────────────────────────────
// visual_preview: asset count + GIF/image mix
// ──────────────────────────────────────────────────────────────────────
function computeVisualPreview(input: DeterministicInput): number {
  if (input.assetsExtractedAt === null) {
    // Extraction wasn't attempted yet; return neutral 2.5 so we don't
    // wrongly gate this repo. The publish gate also checks
    // assets_extracted_at IS NULL and skips the visual_preview check.
    return 2.5;
  }
  const gif = input.repoAssetCount.gif;
  const image = input.repoAssetCount.image;
  if (gif > 0) return 5;
  if (image >= 3) return 4;
  if (image >= 1) return 3;
  return 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
