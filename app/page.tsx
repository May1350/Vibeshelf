import { Button } from "@/components/ui/button"
import { env } from "@/lib/env"

export const dynamic = "force-dynamic"

export default function Home() {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">VibeShelf</h1>
      <p className="text-lg text-muted-foreground">
        Curated open-source templates for vibe coders
      </p>
      <a
        href={`${supabaseUrl}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent("http://localhost:3000/auth/callback")}`}
      >
        <Button size="lg" variant="default">
          Sign in with GitHub
        </Button>
      </a>
    </main>
  )
}
