// Parse a repository's package.json → emit tag slugs from a curated
// mapping table. The mapping is conservative on purpose: we match npm
// package names (case-sensitive, as npm itself is) and emit a single
// canonical slug per match. A repo that pulls both `next` and
// `react` gets both tags; a repo that pulls only `@supabase/ssr`
// (without `@supabase/supabase-js`) still gets `supabase` because both
// entries map to the same canonical slug and we dedupe after.
//
// Invariants:
//   - Pure, synchronous, framework-free (no DB, no network).
//   - Malformed JSON is swallowed and returns [] (caller passes raw
//     GitHub content; we cannot afford to crash the ingestion job on a
//     broken repo).
//   - Dedup by slug — multiple source packages mapping to the same
//     canonical tag produce one output entry.

export interface ExtractedTag {
  slug: string;
  kind: "tech_stack" | "vibecoding_tool" | "feature";
  confidence: number;
}

// Curated mapping: npm package name → canonical tag. Entries grouped by
// category only for readability; lookup is flat. Confidence is 1.0 for
// every entry because these are exact package-name matches (no fuzzy
// inference) — a future version may introduce lower-confidence signals
// (e.g. inferring "react" from JSX filenames) at which point this
// table's uniform 1.0 becomes load-bearing.
const PACKAGE_TO_TAG: Record<string, { slug: string; kind: ExtractedTag["kind"] }> = {
  // ── Frontend frameworks ─────────────────────────────────────────────
  next: { slug: "nextjs", kind: "tech_stack" },
  react: { slug: "react", kind: "tech_stack" },
  "react-dom": { slug: "react", kind: "tech_stack" },
  vue: { slug: "vue", kind: "tech_stack" },
  svelte: { slug: "svelte", kind: "tech_stack" },
  "@sveltejs/kit": { slug: "svelte", kind: "tech_stack" },
  nuxt: { slug: "nuxt", kind: "tech_stack" },
  astro: { slug: "astro", kind: "tech_stack" },
  "solid-js": { slug: "solid", kind: "tech_stack" },
  remix: { slug: "remix", kind: "tech_stack" },
  "@remix-run/react": { slug: "remix", kind: "tech_stack" },

  // ── Backend / API frameworks ────────────────────────────────────────
  express: { slug: "express", kind: "tech_stack" },
  fastify: { slug: "fastify", kind: "tech_stack" },
  hono: { slug: "hono", kind: "tech_stack" },
  koa: { slug: "koa", kind: "tech_stack" },
  "@nestjs/core": { slug: "nestjs", kind: "tech_stack" },
  "@trpc/server": { slug: "trpc", kind: "tech_stack" },
  "@trpc/client": { slug: "trpc", kind: "tech_stack" },
  "@trpc/react-query": { slug: "trpc", kind: "tech_stack" },
  "@trpc/next": { slug: "trpc", kind: "tech_stack" },
  graphql: { slug: "graphql", kind: "tech_stack" },

  // ── DB / BaaS ───────────────────────────────────────────────────────
  "@supabase/supabase-js": { slug: "supabase", kind: "tech_stack" },
  "@supabase/ssr": { slug: "supabase", kind: "tech_stack" },
  prisma: { slug: "prisma", kind: "tech_stack" },
  "@prisma/client": { slug: "prisma", kind: "tech_stack" },
  "drizzle-orm": { slug: "drizzle", kind: "tech_stack" },
  mongoose: { slug: "mongodb", kind: "tech_stack" },
  mongodb: { slug: "mongodb", kind: "tech_stack" },
  pg: { slug: "postgresql", kind: "tech_stack" },
  postgres: { slug: "postgresql", kind: "tech_stack" },
  firebase: { slug: "firebase", kind: "tech_stack" },
  "firebase-admin": { slug: "firebase", kind: "tech_stack" },
  redis: { slug: "redis", kind: "tech_stack" },
  ioredis: { slug: "redis", kind: "tech_stack" },

  // ── Auth ────────────────────────────────────────────────────────────
  "@clerk/nextjs": { slug: "clerk", kind: "tech_stack" },
  "@clerk/clerk-react": { slug: "clerk", kind: "tech_stack" },
  "@clerk/clerk-sdk-node": { slug: "clerk", kind: "tech_stack" },
  auth0: { slug: "auth0", kind: "tech_stack" },
  "@auth0/nextjs-auth0": { slug: "auth0", kind: "tech_stack" },
  "next-auth": { slug: "nextauth", kind: "tech_stack" },
  "@auth/core": { slug: "nextauth", kind: "tech_stack" },

  // ── Payments ────────────────────────────────────────────────────────
  stripe: { slug: "stripe", kind: "tech_stack" },
  "@stripe/stripe-js": { slug: "stripe", kind: "tech_stack" },
  "@stripe/react-stripe-js": { slug: "stripe", kind: "tech_stack" },

  // ── AI SDKs ─────────────────────────────────────────────────────────
  openai: { slug: "openai", kind: "tech_stack" },
  "@anthropic-ai/sdk": { slug: "anthropic", kind: "tech_stack" },
  ai: { slug: "vercel-ai-sdk", kind: "tech_stack" },
  langchain: { slug: "langchain", kind: "tech_stack" },
  "@langchain/core": { slug: "langchain", kind: "tech_stack" },

  // ── Styling / UI ────────────────────────────────────────────────────
  tailwindcss: { slug: "tailwindcss", kind: "tech_stack" },
  "styled-components": { slug: "styled-components", kind: "tech_stack" },
  "@emotion/react": { slug: "emotion", kind: "tech_stack" },
  "@mui/material": { slug: "mui", kind: "tech_stack" },
  "@radix-ui/react-dialog": { slug: "radix-ui", kind: "tech_stack" },
  "@chakra-ui/react": { slug: "chakra-ui", kind: "tech_stack" },

  // ── Language / tooling ──────────────────────────────────────────────
  typescript: { slug: "typescript", kind: "tech_stack" },
  vite: { slug: "vite", kind: "tech_stack" },
  webpack: { slug: "webpack", kind: "tech_stack" },
  turbo: { slug: "turborepo", kind: "tech_stack" },
};

export function extractTechStack(packageJsonContent: string | null): ExtractedTag[] {
  if (packageJsonContent === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonContent);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];

  // Merge dependencies + devDependencies. We do NOT look at
  // peerDependencies (spurious — it documents consumers' requirements,
  // not what this repo actually uses) or optionalDependencies (too
  // weak a signal to tag on).
  const deps = collectDeps(parsed.dependencies);
  const devDeps = collectDeps(parsed.devDependencies);
  const allPackageNames = new Set<string>([...deps, ...devDeps]);

  // Dedupe by canonical slug — several source packages may map to the
  // same tag (e.g. both `@supabase/supabase-js` and `@supabase/ssr`
  // → `supabase`).
  const seen = new Set<string>();
  const results: ExtractedTag[] = [];

  for (const pkg of allPackageNames) {
    const entry = PACKAGE_TO_TAG[pkg];
    if (!entry) continue;
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    results.push({ slug: entry.slug, kind: entry.kind, confidence: 1.0 });
  }

  return results;
}

function collectDeps(value: unknown): string[] {
  if (!isRecord(value)) return [];
  // We only care about the keys (package names). Versions are ignored
  // — we trust that a dependency listed in package.json is intended to
  // be used, without trying to parse semver or verify installs.
  return Object.keys(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
