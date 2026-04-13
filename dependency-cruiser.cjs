// dependency-cruiser.cjs
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ─── DFL rule 1 — lib/pipeline/ is self-contained ────────────────
    {
      name: "no-pipeline-imports-app",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "^app/" },
      comment: "DFL rule 1: pipeline must not import from app/",
    },
    {
      name: "no-pipeline-imports-next",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "/node_modules/next/" },
      comment: "DFL rule 1: pipeline must not import from next",
    },
    {
      name: "no-pipeline-imports-react",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "/node_modules/react/" },
      comment: "DFL rule 1: pipeline must not import from react",
    },

    // ─── DFL rule 3 — lib/types/ is framework-free ───────────────────
    {
      name: "no-types-imports-next",
      severity: "error",
      from: { path: "^lib/types/" },
      to: { path: "/node_modules/next/" },
      comment: "DFL rule 3: shared types must not depend on next",
    },
    {
      name: "no-types-imports-react",
      severity: "error",
      from: { path: "^lib/types/" },
      to: { path: "/node_modules/react/" },
      comment: "DFL rule 3: shared types must not depend on react",
    },
    {
      name: "no-types-imports-server-only",
      severity: "error",
      from: { path: "^lib/types/" },
      to: { path: "/node_modules/server-only/" },
      comment: "DFL rule 3: shared types must not depend on server-only",
    },

    // ─── DFL rule 9 — no cache directives in pipeline ────────────────
    {
      name: "no-pipeline-cache-directives",
      severity: "error",
      from: { path: "^lib/pipeline/" },
      to: { path: "/node_modules/next/cache" },
      comment: "DFL rule 9: pipeline must not use Next.js cache APIs",
    },

    // ─── DFL rule 2 — DB access through lib/db/ only ─────────────────
    {
      name: "pipeline-db-via-lib-db-only",
      severity: "error",
      from: {
        path: "^lib/pipeline/",
        pathNot: "^lib/pipeline/.*\\.test\\.",
      },
      to: { path: "^@supabase/supabase-js$" },
      comment:
        "DFL rule 2: pipeline imports DB client from lib/db/, not @supabase/supabase-js directly",
    },

    // ─── DFL rule 8 — Storage boundary ───────────────────────────────
    // Dep-cruiser cannot see `.storage` member access; it enforces the
    // import boundary. ESLint (§14.2) handles the identifier-level rule.
    //
    // lib/db/** is CARVED OUT of this rule because the three client
    // factories (anon-client.ts, user-client.ts, service-client.ts) must
    // import createClient from @supabase/supabase-js — that is the whole
    // point of having a lib/db/ boundary. Without this carve-out, the
    // rule would false-positive on the factories themselves.
    {
      name: "supabase-js-import-boundary",
      severity: "error",
      from: { pathNot: "^lib/(storage|db)/" },
      to: { path: "^@supabase/supabase-js$", dependencyTypes: ["import"] },
      comment:
        "DFL rule 8 + rule 2: @supabase/supabase-js importable only from lib/db/ and lib/storage/",
    },

    // ─── Foundation rule F1 — service_role client scope ──────────────
    // Initially the OAuth callback was carved out as an allowed importer.
    // A reviewer pass found the callback uses createUserClient() exclusively
    // (§10.4 flow), so the carve-out was dead code — removed. If a concrete
    // caller under app/ ever needs service_role, re-add it with a named
    // justification (and a code comment pointing to this rule).
    {
      name: "no-service-client-in-app",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/db/service-client" },
      comment:
        "F1: createServiceClient is server-only; imported only from lib/pipeline/runJob.ts (never from app/)",
    },

    // ─── Foundation rule F2 — crypto/ import scope ───────────────────
    {
      name: "crypto-tokens-limited-import",
      severity: "error",
      from: {
        pathNot: "^(app/\\(auth\\)/callback/|lib/pipeline/)",
      },
      to: { path: "^lib/crypto/tokens" },
      comment: "F2: tokens.ts importable only from OAuth callback and lib/pipeline/",
    },

    // ─── Foundation rule F3 — pipeline jobs via runJob only ──────────
    {
      name: "pipeline-jobs-via-runjob-only",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/pipeline/jobs/" },
      comment: "F3: app invokes pipeline only via runJob wrapper, not direct job imports",
    },

    // ─── Foundation rule F4 — jobs use ctx.db, not createServiceClient
    // runJob creates ONE service-role client per run and hands it off
    // via ctx.db. Jobs that spawn their own client break the
    // "one client per run" invariant used by OTel span attribution,
    // connection accounting, and future worker-side pool sizing.
    {
      name: "pipeline-jobs-use-ctx-db-only",
      severity: "error",
      from: { path: "^lib/pipeline/jobs/" },
      to: { path: "^lib/db/service-client" },
      comment:
        "F4: pipeline jobs access DB via ctx.db only (runJob owns the single service-role client)",
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
