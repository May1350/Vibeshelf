import { describe, expect, it } from "vitest";
import {
  GeminiContentFilterError,
  GeminiError,
  GeminiRateLimitError,
  GeminiServerError,
  SchemaValidationError,
  TruncatedResponseError,
} from "@/lib/pipeline/gemini/errors";

describe("Gemini error hierarchy", () => {
  it("GeminiRateLimitError is instanceof GeminiError", () => {
    const e = new GeminiRateLimitError("rate limited");
    expect(e).toBeInstanceOf(GeminiError);
    expect(e.name).toBe("GeminiRateLimitError");
  });

  it("GeminiServerError carries status", () => {
    const e = new GeminiServerError(503, "unavailable");
    expect(e.status).toBe(503);
    expect(e.message).toContain("503");
  });

  it("SchemaValidationError preserves raw response", () => {
    const e = new SchemaValidationError("missing field", { partial: true });
    expect(e.raw).toEqual({ partial: true });
  });

  it("all classes set name to constructor name (for log filters)", () => {
    expect(new GeminiContentFilterError("x").name).toBe("GeminiContentFilterError");
    expect(new TruncatedResponseError("x").name).toBe("TruncatedResponseError");
  });
});
