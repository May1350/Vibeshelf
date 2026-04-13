export { createAnonClient } from "./anon-client"
export { createUserClient } from "./user-client"
export { createServiceClient } from "./service-client"
export type { Database } from "./database.types"

// Re-export SupabaseClient typed with our Database for use in lib/types/
// (avoids lib/types/ importing @supabase/supabase-js directly, which
// would violate dep-cruiser rule supabase-js-import-boundary)
export type { SupabaseClient } from "@supabase/supabase-js"
