// lib/auth/revoke-token.ts
// Wrap user-scoped GitHub API calls so a 401 response triggers
// mark_oauth_token_revoked + structured log. Per spec §7.1.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

interface RevokeContext {
  db: SupabaseClient;
  userId: string;
  token: string;
}

export async function withTokenRevocationOn401(
  fn: (token: string) => Promise<Response>,
  ctx: RevokeContext,
): Promise<Response> {
  const res = await fn(ctx.token);
  if (res.status === 401) {
    await ctx.db.rpc("mark_oauth_token_revoked", { p_user_id: ctx.userId });
    console.log(
      JSON.stringify({
        event: "oauth_token_revoked",
        user_id: ctx.userId,
        reason: "401 from GitHub API",
        ts: new Date().toISOString(),
      }),
    );
  }
  return res;
}
