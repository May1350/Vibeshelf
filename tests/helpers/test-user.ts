import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { env } from "@/lib/env"
import type { Database } from "@/lib/db/database.types"

const TEST_PASSWORD = "test-password-safe-for-local-only"

export async function createTestUser(opts?: {
  githubId?: number
  githubUsername?: string
}): Promise<{ userId: string; client: SupabaseClient<Database> }> {
  const admin = createServiceTestClient()
  const email = `test-${crypto.randomUUID()}@example.test`
  const githubId = opts?.githubId ?? Math.floor(Math.random() * 1e9)
  const githubUsername = opts?.githubUsername ?? `test-${githubId}`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: {
      user_name: githubUsername,
      provider_id: String(githubId),
      avatar_url: `https://avatars.githubusercontent.com/u/${githubId}`,
      name: `Test User ${githubId}`,
    },
  })
  if (createErr || !created.user) throw createErr ?? new Error("createUser failed")

  const authClient = createAnonTestClient()
  const { data: signedIn, error: signInErr } = await authClient.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  })
  if (signInErr || !signedIn.session) throw signInErr ?? new Error("sign-in failed")

  const client = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${signedIn.session.access_token}` } },
      auth: { persistSession: false },
    },
  )

  return { userId: created.user.id, client }
}

export function createAnonTestClient(): SupabaseClient<Database> {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}

export function createServiceTestClient(): SupabaseClient<Database> {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
