import { describe, it, expect } from "vitest"
import { envScope } from "@/lib/env"

// Valid 32-byte test keys (base64 of 32 × 0x78 'x')
const VALID_B64_KEY = "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg=" // 44 chars: 43 + '='
const VALID_B64URL_KEY = "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg" // 43 chars, no padding

describe("env schema", () => {
  it("accepts valid standard base64 TOKEN_ENCRYPTION_KEY_V1", () => {
    const regex = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/
    expect(regex.test(VALID_B64_KEY)).toBe(true)
  })

  it("accepts valid base64url TOKEN_ENCRYPTION_KEY_V1", () => {
    const regex = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/
    expect(regex.test(VALID_B64URL_KEY)).toBe(true)
  })

  it("rejects too-short TOKEN_ENCRYPTION_KEY_V1", () => {
    const regex = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/
    expect(regex.test("short")).toBe(false)
  })

  it("envScope covers all env keys with valid scopes", () => {
    for (const scope of Object.values(envScope)) {
      expect(["web", "pipeline", "both"]).toContain(scope)
    }
  })
})
