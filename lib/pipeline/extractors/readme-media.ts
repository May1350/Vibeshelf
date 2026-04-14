// Extract image / GIF URLs from a README markdown blob.
//
// Hybrid approach:
//   1. Parse the markdown with unified + remark-parse and walk the
//      mdast for `image` nodes — catches `![alt](url)` and reference
//      links expanded to images.
//   2. Regex-scan the raw source for `<img src="...">` — catches HTML
//      embeds that remark-parse keeps as opaque `html` nodes.
//
// Both passes feed into one list that is filtered (badge URLs dropped)
// and then sorted so GIFs appear first. Priorities are assigned in
// first-seen order within each kind — the earlier a media appears in
// the README, the more prominent it is likely to be, so it gets a
// numerically LOWER (higher-priority) value.
//
// unified@11 / remark-parse@11 are ESM-only. Our tsconfig has
// `"module": "ESNext"`, so static ESM imports work from both Next
// (Turbopack) and Vitest (Node ESM). If a downstream consumer ends up
// in a CJS context we'll switch to dynamic `await import()`, but we
// intentionally do not pay that cost up front.

import type { Image, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * Parse markdown into an mdast Root. Shared between readme-media (image walker)
 * and readme-sections (heading-based slicing) to avoid parsing the same blob twice.
 */
export function parseReadme(markdown: string): Root {
  return unified().use(remarkParse).parse(markdown) as Root;
}

export interface ExtractedMedia {
  url: string;
  kind: "readme_gif" | "readme_image";
  /** Lower = higher priority. GIFs < images; within a kind, earlier < later. */
  priority: number;
}

// Hosts that serve status / coverage / CI badges. README screenshots
// are not hosted on these — if we see a URL whose hostname matches,
// we drop it. Match is case-insensitive and done via `hostname.endsWith`
// so subdomains (e.g. `img.shields.io`) are covered by the parent
// domain (`shields.io`).
const BADGE_HOSTS: readonly string[] = [
  "shields.io",
  "badgen.net",
  "badge.fury.io",
  "travis-ci.org",
  "travis-ci.com",
  "circleci.com",
  "codecov.io",
  "coveralls.io",
  "app.netlify.com",
  "api.netlify.com",
  "app.travis-ci.com",
  "deepsource.io",
  "snyk.io",
];

// Path patterns that look like badges regardless of host — notably
// GitHub-hosted workflow status badges like
// `github.com/owner/repo/actions/workflows/ci.yml/badge.svg`.
const BADGE_PATH_PATTERNS: readonly RegExp[] = [
  /\/badge\.svg(\?.*)?$/i,
  /\/badges\//i,
  /\/actions\/workflows\/.+\/badge\.svg/i,
  /\/workflow\/badge/i,
];

// Matches `<img ... src="..." ...>` and `<img ... src='...' ...>` —
// the `[^>]+` anchors the src attribute to the same tag (no crossing
// tag boundaries). Flags: `g` for repeated matches, `i` for
// case-insensitive tag name.
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;

export async function extractReadmeMedia(readmeMarkdown: string): Promise<ExtractedMedia[]> {
  // Short-circuit for empty input — remark still works on it, but we
  // save a parser instantiation + a visit pass.
  if (!readmeMarkdown) return [];

  // `found` preserves first-seen order for priority assignment.
  const found: { url: string; kind: ExtractedMedia["kind"] }[] = [];
  const seen = new Set<string>();

  const push = (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    if (seen.has(url)) return;
    // Drop data URLs: they embed raw bytes, can't be host-mirrored,
    // and wastefully bloat DB rows.
    if (url.startsWith("data:")) return;
    // Drop URLs that were relative in the source markdown. Without
    // repo owner/branch context we can't resolve them to a fetchable
    // URL; downstream asset mirroring would 404 on every one.
    if (isRelativeOrInvalid(url)) return;
    if (isBadgeUrl(url)) return;
    seen.add(url);
    found.push({ url, kind: classifyKind(url) });
  };

  // ── 1) mdast walk for markdown image syntax ──────────────────────────
  try {
    const tree = parseReadme(readmeMarkdown);
    visit(tree, "image", (node: Image) => {
      if (typeof node.url === "string") push(node.url);
    });
  } catch {
    // Malformed markdown should never reach this catch — remark is very
    // tolerant — but we defend against it anyway. Fall through to the
    // regex pass, which works on any string.
  }

  // ── 2) Regex pass for raw HTML <img> tags ────────────────────────────
  // We reset lastIndex to 0 to avoid sticky-state surprises from the
  // module-level RegExp with the `g` flag.
  HTML_IMG_RE.lastIndex = 0;
  let match: RegExpExecArray | null = HTML_IMG_RE.exec(readmeMarkdown);
  while (match !== null) {
    const src = match[1];
    if (src) push(src);
    match = HTML_IMG_RE.exec(readmeMarkdown);
  }

  // ── 3) Assign priorities — GIFs 10..., images 20... ───────────────────
  // Counters track per-kind order-of-appearance within the (already
  // deduped, already badge-filtered) `found` list.
  let gifCount = 0;
  let imgCount = 0;
  const results: ExtractedMedia[] = [];
  for (const { url, kind } of found) {
    if (kind === "readme_gif") {
      results.push({ url, kind, priority: 10 + gifCount });
      gifCount += 1;
    } else {
      results.push({ url, kind, priority: 20 + imgCount });
      imgCount += 1;
    }
  }

  // Final sort by priority so callers get a deterministic order
  // regardless of how we interleaved the two passes above.
  results.sort((a, b) => a.priority - b.priority);
  return results;
}

function classifyKind(url: string): ExtractedMedia["kind"] {
  // Strip query string + hash before extension check — a URL like
  // `x.gif?v=1` or `x.gif#anchor` still terminates in `.gif` for our
  // purposes.
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  return clean.toLowerCase().endsWith(".gif") ? "readme_gif" : "readme_image";
}

/**
 * Detect URLs that were relative in the markdown source (e.g.
 * `docs/screenshot.png`) or otherwise unparseable. `new URL(url, base)`
 * with a dummy base resolves relatives against it, so we check the
 * resulting host: if it's our dummy base, the URL was relative.
 * Protocol-relative (`//cdn.example/x.png`) URLs resolve to a real
 * host and are kept.
 */
function isRelativeOrInvalid(url: string): boolean {
  try {
    const parsed = new URL(url, "https://dummy.invalid/");
    return parsed.hostname === "dummy.invalid";
  } catch {
    return true;
  }
}

function isBadgeUrl(url: string): boolean {
  // We need a URL object to inspect hostname + pathname separately.
  // Protocol-relative URLs (`//example.com/x.png`) and naked paths
  // (`./screenshots/foo.png`) are not valid inputs to `new URL`
  // without a base, so we attempt parsing with a dummy base and fall
  // back to string-matching on the original.
  let parsed: URL | null = null;
  try {
    parsed = new URL(url, "https://dummy.invalid/");
  } catch {
    parsed = null;
  }

  if (parsed) {
    const host = parsed.hostname.toLowerCase();
    for (const badgeHost of BADGE_HOSTS) {
      if (host === badgeHost || host.endsWith(`.${badgeHost}`)) return true;
    }
    // Host check missed — try the path patterns. We run these on the
    // full URL (pathname + search) because some badge URLs put the
    // identifying substring in the query.
    const pathAndQuery = parsed.pathname + parsed.search;
    for (const re of BADGE_PATH_PATTERNS) {
      if (re.test(pathAndQuery)) return true;
    }
  } else {
    // Unparseable URL — string-match as a last resort.
    for (const re of BADGE_PATH_PATTERNS) {
      if (re.test(url)) return true;
    }
  }

  return false;
}
