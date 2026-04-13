import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";

describe("encryptToken / decryptToken", () => {
  it("round-trips a plaintext correctly", () => {
    const plaintext = "ghp_abcdef123456";
    const encrypted = encryptToken(plaintext, 1);
    const decrypted = decryptToken(encrypted, 1);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for same plaintext (random IV)", () => {
    const plaintext = "ghp_test";
    const a = encryptToken(plaintext, 1);
    const b = encryptToken(plaintext, 1);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("throws on unknown key version", () => {
    expect(() => encryptToken("test", 99)).toThrow("unknown key version");
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptToken("test", 1);
    encrypted[20] = ((encrypted[20] ?? 0) ^ 0xff) & 0xff;
    expect(() => decryptToken(encrypted, 1)).toThrow();
  });

  it("round-trips 100 random plaintexts", () => {
    for (let i = 0; i < 100; i++) {
      const pt = `token-${crypto.randomUUID()}`;
      const enc = encryptToken(pt, 1);
      expect(decryptToken(enc, 1)).toBe(pt);
    }
  });
});
