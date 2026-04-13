import { createUserClient } from "@/lib/db/user-client";
import { env } from "@/lib/env";

const BUCKET = "review-assets";
type Extension = "png" | "jpg" | "jpeg" | "webp" | "gif";

export async function uploadReviewImage(
  userId: string,
  reviewId: string,
  ordering: 0 | 1 | 2 | 3 | 4,
  extension: Extension,
  data: Blob,
): Promise<{ storageKey: string }> {
  const storageKey = `${userId}/${reviewId}/${ordering}.${extension}`;
  const supabase = await createUserClient();
  const { error } = await supabase.storage.from(BUCKET).upload(storageKey, data, { upsert: false });
  if (error) throw error;
  return { storageKey };
}

export async function deleteReviewImage(storageKey: string): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.storage.from(BUCKET).remove([storageKey]);
  if (error) throw error;
}

export function reviewImagePublicUrl(storageKey: string): string {
  return `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storageKey}`;
}
