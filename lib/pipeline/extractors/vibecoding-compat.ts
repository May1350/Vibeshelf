// Detect which vibecoding tools a repo is configured for, based on
// the root-level file tree. Each tool leaves a signature marker — a
// dotfile, a directory, or a config file — and we match those to
// canonical slugs.
//
// Matching is done on path segments (not substrings) so that e.g.
// `.cursorrules` matches but `.cursorrules-template` does not. Path
// separators are normalised with a forward slash because GitHub's
// tree API returns posix-style paths even for repos authored on
// Windows.
//
// Pure, synchronous, framework-free.

import type { ExtractedTag } from "./tech-stack";

export interface FileTreeEntry {
  /** Path relative to repo root. POSIX separators expected. */
  path: string;
  type: "file" | "dir";
}

interface DetectionRule {
  slug: string;
  /** Returns true if this entry signals the tool is present. */
  match: (entry: FileTreeEntry) => boolean;
}

// NOTE: repo-details.ts fetches the tree NON-recursively. So all rules
// below assume root-level entries only. Sub-path checks (e.g.
// `.cursor/rules/*.md`) are intentionally dropped — the presence of
// the `.cursor/rules` directory at root is a sufficient signal.
const RULES: readonly DetectionRule[] = [
  // Cursor: either the legacy `.cursorrules` root file or the newer
  // `.cursor/rules/` directory (we'll see `.cursor` at root as a dir).
  {
    slug: "cursor",
    match: (e) => {
      const p = normalise(e.path);
      if (p === ".cursorrules") return true;
      if (p === ".cursor" && e.type === "dir") return true;
      return false;
    },
  },
  // Bolt: `.bolt/` directory OR `bolt.config.*` at root
  {
    slug: "bolt",
    match: (e) => {
      const p = normalise(e.path);
      if (p === ".bolt" && e.type === "dir") return true;
      if (/^bolt\.config\.[^/]+$/i.test(p)) return true;
      return false;
    },
  },
  // Lovable: `lovable.config.*` OR `.lovable` at root
  {
    slug: "lovable",
    match: (e) => {
      const p = normalise(e.path);
      if (/^lovable\.config\.[^/]+$/i.test(p)) return true;
      if (p === ".lovable") return true;
      return false;
    },
  },
  // Replit: the single well-known `.replit` manifest at repo root.
  {
    slug: "replit",
    match: (e) => normalise(e.path) === ".replit",
  },
];

export function extractVibecodingCompat(fileTree: FileTreeEntry[]): ExtractedTag[] {
  const detected = new Set<string>();

  for (const entry of fileTree) {
    if (!entry || typeof entry.path !== "string") continue;
    for (const rule of RULES) {
      if (detected.has(rule.slug)) continue;
      if (rule.match(entry)) detected.add(rule.slug);
    }
    // Small optimisation: if we've already matched every rule, we can
    // bail out early. The constant is tiny so this is more about
    // intent than perf.
    if (detected.size === RULES.length) break;
  }

  return [...detected].map((slug) => ({
    slug,
    kind: "vibecoding_tool" as const,
    confidence: 1.0,
  }));
}

function normalise(path: string): string {
  // Collapse backslashes to forward slashes and strip a leading `./`
  // if present. We do NOT strip leading `/` because that would
  // conflate an absolute path with a root-relative one — the API
  // contract says paths are repo-root-relative.
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
