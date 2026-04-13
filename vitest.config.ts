import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-placeholder",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-placeholder",
      TOKEN_ENCRYPTION_KEY_V1: "OFcwVXjTtYGTXwzWU9CM5kRCj/AkYNTY3a6ZZYV1vUo=",
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
    },
  },
})
