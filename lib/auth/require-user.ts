// lib/auth/require-user.ts
// Server-only: current user or 401. Use in Route Handlers.

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export async function requireUser(): Promise<{
  userId: string;
  db: ReturnType<typeof createServerClient>;
}> {
  const cookieStore = await cookies();
  const db = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError();
  return { userId: data.user.id, db };
}
