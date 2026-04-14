import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TOKEN_ENCRYPTION_KEY_V1: z.string().regex(/^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/, {
    message:
      "TOKEN_ENCRYPTION_KEY_V1 must be base64(32 bytes) — standard (44 chars with '=') or base64url (43 chars, no padding)",
  }),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GEMINI_API_KEY: z.string().optional(),
  VERCEL_OIDC_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().min(1),
  RESCORE_DRAIN_MODE: z.enum(["true", "false"]).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;

export const envScope = {
  NEXT_PUBLIC_SUPABASE_URL: "both",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "both",
  SUPABASE_SERVICE_ROLE_KEY: "pipeline",
  TOKEN_ENCRYPTION_KEY_V1: "both",
  GITHUB_CLIENT_ID: "web",
  GITHUB_CLIENT_SECRET: "web",
  GEMINI_API_KEY: "pipeline",
  VERCEL_OIDC_TOKEN: "both",
  CRON_SECRET: "pipeline",
  RESCORE_DRAIN_MODE: "pipeline",
  NEXT_PUBLIC_SITE_URL: "both",
} as const satisfies Record<keyof Env, "web" | "pipeline" | "both">;
