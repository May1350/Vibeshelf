// Thin wrapper around @google/genai. Validates GEMINI_API_KEY at instantiation
// (keeping env.ts's GEMINI_API_KEY as optional so web-scope cold boot doesn't
// fail — validation is deferred to the point of use).
//
// Error taxonomy:
//   - 429 Too Many Requests    → GeminiRateLimitError (no retry; job halts)
//   - 5xx                      → GeminiServerError (retry with backoff)
//   - SAFETY / BLOCKED         → GeminiContentFilterError (no retry)
//   - MAX_TOKENS finishReason  → TruncatedResponseError (no retry with same prompt)
//   - JSON parse failure       → SchemaValidationError (retry with error re-injection)

import { GoogleGenAI } from "@google/genai";
import { env } from "@/lib/env";
import type { RequestBudget } from "@/lib/pipeline/scoring/request-budget";
import {
  GeminiContentFilterError,
  GeminiRateLimitError,
  GeminiServerError,
  SchemaValidationError,
  TruncatedResponseError,
} from "./errors";

export interface GeminiScoreRequest {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: object;
  model: string;
}

export interface GeminiScoreResponse {
  /** Parsed JSON matching `responseSchema`. */
  data: unknown;
  inputTokens: number;
  outputTokens: number;
}

export class GeminiClient {
  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY required for scoring pipeline");
    }
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async score(req: GeminiScoreRequest, budget: RequestBudget): Promise<GeminiScoreResponse> {
    const MAX_RETRIES = 2;
    let lastError: unknown;
    let currentReq = req;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (!budget.canProceed()) {
        throw lastError ?? new Error("budget exhausted before call");
      }

      try {
        const response = await this.client.models.generateContent({
          model: currentReq.model,
          contents: [{ role: "user", parts: [{ text: currentReq.userPrompt }] }],
          config: {
            systemInstruction: currentReq.systemPrompt,
            responseMimeType: "application/json",
            responseSchema: currentReq.responseSchema as never,
          },
        });

        // Token accounting
        const input = response.usageMetadata?.promptTokenCount ?? 0;
        const output = response.usageMetadata?.candidatesTokenCount ?? 0;
        budget.recordCall(input, output);

        // Finish reason check (truncation / safety). The SDK exposes a
        // `FinishReason` enum whose string values match the API; we compare
        // as strings so we don't pull the enum in for a single branch.
        const finishReason = response.candidates?.[0]?.finishReason as string | undefined;
        if (finishReason === "MAX_TOKENS") {
          throw new TruncatedResponseError("Gemini response truncated (MAX_TOKENS)");
        }
        if (
          finishReason === "SAFETY" ||
          finishReason === "BLOCKLIST" ||
          finishReason === "PROHIBITED_CONTENT" ||
          finishReason === "SPII"
        ) {
          throw new GeminiContentFilterError(`Gemini content filter: ${finishReason}`);
        }

        const text = response.text ?? "";
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          throw new SchemaValidationError(`JSON parse failed: ${String(parseErr)}`, text);
        }

        return { data: parsed, inputTokens: input, outputTokens: output };
      } catch (err) {
        lastError = err;

        // Terminal — do not retry.
        if (err instanceof GeminiContentFilterError) throw err;
        if (err instanceof TruncatedResponseError) throw err;

        // 429 — halt immediately; next cron will retry.
        if (isRateLimit(err)) {
          throw err instanceof GeminiRateLimitError
            ? err
            : new GeminiRateLimitError(describeError(err));
        }

        // 5xx — retry with exponential backoff.
        if (isServerError(err)) {
          if (attempt < MAX_RETRIES) {
            await sleep(Math.pow(4, attempt) * 500);
            continue;
          }
          throw new GeminiServerError(extractStatus(err) ?? 500, describeError(err));
        }

        // Schema parse failure — retry with error re-injection.
        if (err instanceof SchemaValidationError) {
          if (attempt < MAX_RETRIES) {
            currentReq = {
              ...currentReq,
              userPrompt: `${currentReq.userPrompt}\n\n주의: 이전 응답이 스키마 검증에 실패했습니다 (${err.message}). 제공된 JSON 스키마에 정확히 일치하는 JSON만 반환하세요.`,
            };
            continue;
          }
          throw err;
        }

        // Unknown error — bubble up.
        throw err;
      }
    }

    throw lastError ?? new Error("unreachable");
  }
}

function isRateLimit(err: unknown): boolean {
  if (err instanceof GeminiRateLimitError) return true;
  return extractStatus(err) === 429;
}

function isServerError(err: unknown): boolean {
  if (err instanceof GeminiServerError) return true;
  const status = extractStatus(err);
  return typeof status === "number" && status >= 500 && status < 600;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
