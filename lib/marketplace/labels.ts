// Display-label dictionary for taxonomy slugs.
//
// The auto-titlecasing in filter-sidebar.tsx blindly uppercases each token —
// "ai_tool" → "Ai Tool", "ci_cd" → "Ci Cd". This dictionary returns the
// canonical brand/acronym form. Unknown slugs fall back to a humanize that
// uppercases tokens but preserves known acronyms.

const CATEGORY: Record<string, string> = {
  saas: "SaaS",
  ecommerce: "E-commerce",
  dashboard: "Dashboard",
  landing_page: "Landing Page",
  ai_tool: "AI Tool",
  utility: "Utility",
  game: "Game",
  portfolio: "Portfolio",
  blog: "Blog",
  chatbot: "Chatbot",
  mobile_app: "Mobile App",
  other: "Other",
};

const TAG: Record<string, string> = {
  auth: "Auth",
  responsive: "Responsive",
  docker: "Docker",
  dark_mode: "Dark Mode",
  ci_cd: "CI/CD",
  i18n: "i18n",
  seo: "SEO",
  ai_integration: "AI Integration",
  email: "Email",
  database_included: "Database",
  self_hostable: "Self-hostable",
  pwa: "PWA",
  api: "API",
  graphql: "GraphQL",
  rest: "REST",
};

const VIBECODING: Record<string, string> = {
  cursor: "Cursor",
  bolt: "Bolt",
  lovable: "Lovable",
  replit: "Replit",
};

const ACRONYMS = new Set([
  "ai",
  "api",
  "cd",
  "ci",
  "css",
  "db",
  "html",
  "io",
  "ios",
  "js",
  "ml",
  "nlp",
  "orm",
  "pwa",
  "saas",
  "seo",
  "sql",
  "ssr",
  "ts",
  "ui",
  "ux",
]);

function humanize(slug: string): string {
  return slug
    .split("_")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function categoryLabel(slug: string): string {
  return CATEGORY[slug] ?? humanize(slug);
}

export function tagLabel(slug: string): string {
  return TAG[slug] ?? humanize(slug);
}

export function vibecodingLabel(slug: string): string {
  return VIBECODING[slug] ?? humanize(slug);
}

// SPDX identifiers are conventionally uppercase (MIT, Apache-2.0). The DB
// stores them lowercased on the ingest path (`license_spdx ?? "unknown"` is
// downcased somewhere). Until the ingest is normalized, render-side fix.
export function licenseLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "unknown") return "—";
  return trimmed.toUpperCase();
}
