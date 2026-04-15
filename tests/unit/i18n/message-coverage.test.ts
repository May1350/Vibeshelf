// tests/unit/i18n/message-coverage.test.ts
// Fails if any referenced t() key is missing from ko.json or en.json,
// OR if ko and en drift apart in key structure. Run via `pnpm test:unit`.

import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import ko from "@/messages/ko.json";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "object" && v !== null
      ? flattenKeys(v as Record<string, unknown>, key)
      : [key];
  });
}

describe("i18n message coverage", () => {
  it("ko and en have identical key sets", () => {
    const koKeys = flattenKeys(ko).sort();
    const enKeys = flattenKeys(en).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it("every key value in ko is a non-empty string", () => {
    for (const key of flattenKeys(ko)) {
      const val = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], ko);
      expect(typeof val).toBe("string");
      expect((val as string).length).toBeGreaterThan(0);
    }
  });

  it("every key value in en is a non-empty string", () => {
    for (const key of flattenKeys(en)) {
      const val = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);
      expect(typeof val).toBe("string");
      expect((val as string).length).toBeGreaterThan(0);
    }
  });
});
