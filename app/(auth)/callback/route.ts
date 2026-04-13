import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { encryptToken } from "@/lib/crypto/tokens";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=missing_code`);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { session },
    error,
  } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !session) {
    console.error("Auth callback error:", error?.message);
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
  }

  // Store encrypted GitHub provider_token via SECURITY DEFINER function
  if (session.provider_token) {
    const encrypted = encryptToken(session.provider_token, 1);
    // Convert Buffer to array for Supabase RPC (bytea transfer)
    // Type assertion needed: DB types expect string but RPC accepts number[] for bytea
    const { error: rpcError } = await supabase.rpc("upsert_user_oauth_token", {
      p_token_encrypted: Array.from(encrypted) as unknown as string,
      p_token_key_version: 1,
      p_scopes: ["public_repo"],
    });

    if (rpcError) {
      console.error("Token storage error:", rpcError.message);
      // Non-fatal — user is signed in, token storage can be retried
    }
  }

  return NextResponse.redirect(`${origin}${next}`);
}
