// Extract README sections by heading. Gemini gets section-extracted content
// (Features, Getting Started, Usage, Tech Stack) for much higher signal density
// than head-truncation. Falls back to first 8000 chars if no headings found.

import type { Heading, Root, RootContent } from "mdast";
import { parseReadme } from "./readme-media";

const TARGET_HEADINGS = [
  "features",
  "getting started",
  "quick start",
  "installation",
  "install",
  "setup",
  "usage",
  "tech stack",
  "stack",
  "what's inside",
];

const FALLBACK_LIMIT = 8000;

export interface ExtractedSections {
  /** Concatenated target sections, or first 8k chars fallback. */
  content: string;
  /** True if heading-based extraction succeeded. */
  structured: boolean;
}

export function extractReadmeSections(markdown: string): ExtractedSections {
  if (!markdown) return { content: "", structured: false };

  let tree: Root;
  try {
    tree = parseReadme(markdown);
  } catch {
    return fallback(markdown);
  }

  const sections: string[] = [];
  const children = tree.children;

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!node || !isHeading(node)) continue;
    const title = headingText(node).trim().toLowerCase();
    if (!TARGET_HEADINGS.some((t) => title.includes(t))) continue;

    // Collect nodes until the next heading at the same or higher level
    const start = i;
    let end = i + 1;
    const startLevel = node.depth;
    while (end < children.length) {
      const next = children[end];
      if (next && isHeading(next) && next.depth <= startLevel) break;
      end += 1;
    }
    sections.push(nodesToString(children.slice(start, end), markdown));
  }

  if (sections.length === 0) return fallback(markdown);
  return { content: sections.join("\n\n").slice(0, FALLBACK_LIMIT), structured: true };
}

function fallback(markdown: string): ExtractedSections {
  return { content: markdown.slice(0, FALLBACK_LIMIT), structured: false };
}

function isHeading(node: RootContent): node is Heading {
  return node.type === "heading";
}

function headingText(node: Heading): string {
  return node.children.map((c) => ("value" in c ? c.value : "")).join("");
}

function nodesToString(nodes: RootContent[], original: string): string {
  if (nodes.length === 0) return "";
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first?.position || !last?.position) return "";
  return original.slice(
    first.position.start.offset ?? 0,
    last.position.end.offset ?? original.length,
  );
}
