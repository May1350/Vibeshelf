import { describe, expect, it } from "vitest";
import { ALLOWED_LICENSES, isLicenseAllowed } from "@/lib/pipeline/github/license-allowlist";

describe("ALLOWED_LICENSES", () => {
  it("contains the canonical permissive SPDX identifiers", () => {
    expect(ALLOWED_LICENSES.has("mit")).toBe(true);
    expect(ALLOWED_LICENSES.has("apache-2.0")).toBe(true);
    expect(ALLOWED_LICENSES.has("bsd-2-clause")).toBe(true);
    expect(ALLOWED_LICENSES.has("bsd-3-clause")).toBe(true);
    expect(ALLOWED_LICENSES.has("0bsd")).toBe(true);
  });

  it("stores identifiers in lowercase", () => {
    for (const id of ALLOWED_LICENSES) {
      expect(id).toBe(id.toLowerCase());
    }
  });
});

describe("isLicenseAllowed", () => {
  it("accepts allowed SPDX ids (lowercase)", () => {
    expect(isLicenseAllowed("mit")).toBe(true);
    expect(isLicenseAllowed("apache-2.0")).toBe(true);
    expect(isLicenseAllowed("bsd-3-clause")).toBe(true);
    expect(isLicenseAllowed("0bsd")).toBe(true);
  });

  it("accepts allowed SPDX ids regardless of case", () => {
    expect(isLicenseAllowed("MIT")).toBe(true);
    expect(isLicenseAllowed("Apache-2.0")).toBe(true);
    expect(isLicenseAllowed("BSD-3-Clause")).toBe(true);
  });

  it("rejects copyleft SPDX ids (gpl family)", () => {
    expect(isLicenseAllowed("gpl-3.0")).toBe(false);
    expect(isLicenseAllowed("agpl-3.0")).toBe(false);
    expect(isLicenseAllowed("GPL-3.0")).toBe(false);
  });

  it("rejects null input", () => {
    expect(isLicenseAllowed(null)).toBe(false);
  });

  it("rejects undefined input", () => {
    expect(isLicenseAllowed(undefined)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isLicenseAllowed("")).toBe(false);
  });
});
