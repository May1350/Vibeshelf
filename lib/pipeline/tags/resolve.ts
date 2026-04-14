// Two-layer tag resolution, designed to support both the eager-link pattern
// (discover.ts: tag rows + junction in one helper) AND the atomic-link pattern
// (score-repo.ts: resolve IDs → pass to apply_score_result RPC which does the
// junction insert inside a single DB transaction).
//
//   resolveTagIds         → upserts tag ROWS only (returns IDs)
//   upsertAndLinkTags     → rows + junction (convenience wrapper)

import type { SupabaseClient } from "@/lib/db";

export interface TagInput {
  slug: string;
  kind: "tech_stack" | "vibecoding_tool" | "feature";
  label?: string;
  confidence: number;
  source: "auto" | "auto_llm" | "manual";
}

export interface ResolvedTag {
  slug: string;
  id: string;
  confidence: number;
  source: TagInput["source"];
}

interface TagRow {
  id: string;
  slug: string;
  kind: TagInput["kind"];
}

/**
 * Upsert tag rows (not repo_tags junction). Returns resolved IDs in the
 * same order as input. Callers that want atomicity on the junction pass
 * these IDs to apply_score_result RPC. Callers that are OK with non-atomic
 * writes (e.g., discoverJob) use upsertAndLinkTags below.
 *
 * Orphaned tag rows (if the caller fails before junction insert) are
 * harmless — they're just unused rows in the lookup table.
 */
export async function resolveTagIds(
  db: SupabaseClient,
  tags: readonly TagInput[],
): Promise<ResolvedTag[]> {
  if (tags.length === 0) return [];

  // Dedupe by (slug, kind) — a caller could emit the same slug twice
  // (e.g. two extractors both map to "react").
  const seen = new Set<string>();
  const unique: TagInput[] = [];
  for (const t of tags) {
    const key = `${t.kind}:${t.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  // Batch-select existing tag rows by slug (citext → case-insensitive).
  const slugs = unique.map((t) => t.slug);
  const { data: existing, error: selErr } = await db
    .from("tags")
    .select("id, slug, kind")
    .in("slug", slugs);
  if (selErr) throw new Error(`tags select failed: ${selErr.message}`);

  const byKey = new Map<string, TagRow>();
  for (const row of (existing ?? []) as TagRow[]) {
    byKey.set(`${row.kind}:${row.slug.toLowerCase()}`, row);
  }

  // Insert missing rows in one upsert.
  const missing = unique.filter((t) => !byKey.has(`${t.kind}:${t.slug.toLowerCase()}`));
  if (missing.length > 0) {
    const rows = missing.map((t) => ({
      slug: t.slug,
      kind: t.kind,
      label: t.label ?? humanize(t.slug),
    }));
    const { data: inserted, error: insErr } = await db
      .from("tags")
      .upsert(rows, { onConflict: "slug", ignoreDuplicates: false })
      .select("id, slug, kind");
    if (insErr) throw new Error(`tags insert failed: ${insErr.message}`);
    for (const row of (inserted ?? []) as TagRow[]) {
      byKey.set(`${row.kind}:${row.slug.toLowerCase()}`, row);
    }
  }

  const resolved: ResolvedTag[] = [];
  for (const t of unique) {
    const row = byKey.get(`${t.kind}:${t.slug.toLowerCase()}`);
    if (!row) continue;
    resolved.push({ slug: t.slug, id: row.id, confidence: t.confidence, source: t.source });
  }
  return resolved;
}

/**
 * Convenience wrapper: upserts tag rows AND inserts repo_tags junction.
 * Used by discoverJob (eager-link pattern — no separate atomicity boundary).
 * scoreRepo should NOT use this; it passes resolveTagIds output to
 * apply_score_result RPC instead (atomic with the score insert).
 */
export async function upsertAndLinkTags(
  db: SupabaseClient,
  repoId: string,
  tags: readonly TagInput[],
): Promise<{ linked: number }> {
  const resolved = await resolveTagIds(db, tags);
  if (resolved.length === 0) return { linked: 0 };

  const junctionRows = resolved.map((r) => ({
    repo_id: repoId,
    tag_id: r.id,
    confidence: r.confidence,
    source: r.source,
  }));

  const { error } = await db
    .from("repo_tags")
    .upsert(junctionRows, { onConflict: "repo_id,tag_id", ignoreDuplicates: true });
  if (error) throw new Error(`repo_tags upsert failed: ${error.message}`);

  return { linked: junctionRows.length };
}

function humanize(slug: string): string {
  // e.g. "nextjs" → "Nextjs", "react-query" → "React Query",
  //      "shadcn_ui" → "Shadcn Ui"
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
}
