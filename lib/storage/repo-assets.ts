import { createServiceClient } from "@/lib/db/service-client"

const BUCKET = "repo-assets"

export type AssetKind = "readme_gif" | "readme_image" | "demo_screenshot" | "ai_generated"

export async function uploadRepoAsset(
  repoId: string,
  kind: AssetKind,
  filename: string,
  data: Blob,
): Promise<{ storageKey: string }> {
  const storageKey = `${repoId}/${kind}/${filename}`
  const supabase = createServiceClient()
  const { error } = await supabase.storage.from(BUCKET).upload(storageKey, data, { upsert: false })
  if (error) throw error
  return { storageKey }
}

export async function signedRepoAssetUrl(storageKey: string, ttlSec = 3600): Promise<string> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storageKey, ttlSec)
  if (error) throw error
  return data.signedUrl
}
