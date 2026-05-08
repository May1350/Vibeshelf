// lib/auth/decrypt-oauth-token.ts
// Server-only: load encrypted GitHub provider_token for the current user,
// decrypt, return plaintext. The plaintext NEVER leaves this module scope
// in a way that outlives a single request handler.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken } from "@/lib/crypto/tokens";

export async function decryptOAuthToken(
  db: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("github_oauth_tokens")
    .select("token_encrypted, token_key_version")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`decryptOAuthToken: ${error.message}`);
  if (!data) return null;
  // bytea comes back from PostgREST as `\x<hex>` string — decode first.
  const hex = (data.token_encrypted as unknown as string).replace(/^\\x/, "");
  const buf = Buffer.from(hex, "hex");
  return decryptToken(buf, data.token_key_version);
}
