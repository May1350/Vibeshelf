import { execSync } from "node:child_process";

export async function setup() {
  try {
    execSync("/opt/homebrew/bin/supabase status", { stdio: "pipe" });
  } catch {
    try {
      console.log("Starting Supabase local stack...");
      execSync("/opt/homebrew/bin/supabase start", { stdio: "inherit" });
    } catch (_startErr) {
      // Docker not available — unit tests can still run without Supabase
      console.warn(
        "Supabase could not be started (Docker may not be running). Integration tests will fail.",
      );
      return;
    }
  }
  try {
    execSync("/opt/homebrew/bin/supabase db reset --no-seed", { stdio: "inherit" });
  } catch (_resetErr) {
    console.warn("supabase db reset failed — integration tests may fail.");
  }
}

export async function teardown() {
  // Leave running — CI stops it in the always() step
}
