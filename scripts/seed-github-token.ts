// scripts/seed-github-token.ts
// One-off: encrypt GITHUB_PAT_DEV from .env.local and insert into
// github_tokens for both 'search' and 'rest' scopes.
//
// Usage: pnpm tsx scripts/seed-github-token.ts
//
// Inlines the AES-256-GCM logic from lib/crypto/tokens.ts to avoid
// importing lib/env (which would force-validate every web/pipeline env
// at module load time and fail in script context).

import { config } from "dotenv";
config({ path: ".env.local" });

import { createCipheriv, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function encryptToken(plaintext: string, keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

async function main() {
  const pat = process.env.GITHUB_PAT_DEV;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keyB64 = process.env.TOKEN_ENCRYPTION_KEY_V1;
  if (!pat) throw new Error("GITHUB_PAT_DEV missing in .env.local");
  if (!url || !svc) throw new Error("Supabase env missing");
  if (!keyB64) throw new Error("TOKEN_ENCRYPTION_KEY_V1 missing");

  const db = createClient(url, svc, { auth: { persistSession: false } });
  const encrypted = encryptToken(pat, keyB64);

  for (const scope of ["search", "rest"] as const) {
    const label = `dev-pat-${scope}-${Date.now()}`;
    const hex = `\\x${encrypted.toString("hex")}`;
    const { error } = await db.from("github_tokens").insert({
      label,
      token_encrypted: hex,
      token_key_version: 1,
      scope,
    });
    if (error) throw new Error(`insert(${scope}): ${error.message}`);
    console.log(`inserted ${scope} token: ${label}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
