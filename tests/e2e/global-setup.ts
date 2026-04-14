import { spawnSync } from "node:child_process";

/**
 * Playwright global setup — seeds the local Supabase DB with fixture repos
 * before the e2e suite runs. Refuses gracefully if seed fails so the caller
 * sees the real cause in stdout.
 */
export default async function globalSetup(): Promise<void> {
  console.log("[e2e] seeding local DB via pnpm seed:dev...");
  const result = spawnSync("pnpm", ["seed:dev"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`[e2e] seed:dev failed with status ${result.status}`);
  }
}
