// Builds the single-prompt scoring request for Gemini Flash-Lite.
// See docs/superpowers/specs/2026-04-14-evaluation-classification-design.md §2.

import { SEED_FEATURE_TAG_SLUGS } from "@/lib/pipeline/scoring/seed-feature-tags";

export const SCORING_PROMPT_VERSION = "1.0.0";
export const SCORING_MODEL = "gemini-flash-lite-latest";

const CATEGORIES = [
  "saas",
  "ecommerce",
  "dashboard",
  "landing_page",
  "ai_tool",
  "utility",
  "game",
  "portfolio",
  "blog",
  "chatbot",
  "mobile_app",
  "other",
] as const;

export interface ScoringPromptInput {
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  lastCommitIso: string;
  license: string | null;
  techStackSlugs: readonly string[];
  vibecodingToolSlugs: readonly string[];
  hasReadme: boolean;
  hasPackageJson: boolean;
  /** Structure-extracted README sections, or first-8k fallback. Empty if has_readme=false. */
  readmeSections: string;
}

export interface ScoringPromptOutput {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: object;
  version: string;
}

export function buildScoringPrompt(input: ScoringPromptInput): ScoringPromptOutput {
  const systemPrompt =
    "당신은 오픈소스 GitHub 리포의 품질을 평가하는 큐레이터입니다. " +
    "바이브코더(비개발자 + Cursor/Lovable/Bolt 유저)가 이 템플릿을 자기 프로젝트에 " +
    "써도 될지 판단하는 것이 목적입니다.";

  const userPrompt = buildUserPrompt(input);
  const responseSchema = buildResponseSchema();

  return { systemPrompt, userPrompt, responseSchema, version: SCORING_PROMPT_VERSION };
}

function buildUserPrompt(input: ScoringPromptInput): string {
  const lines: string[] = [];
  lines.push(`리포: ${input.owner}/${input.name}`);
  if (input.description) lines.push(`설명: ${input.description}`);
  lines.push(`스타: ${input.stars}`);
  lines.push(`마지막 커밋: ${input.lastCommitIso}`);
  if (input.license) lines.push(`라이선스: ${input.license}`);
  if (input.techStackSlugs.length > 0) {
    lines.push(
      `감지된 기술스택: ${input.techStackSlugs.join(", ")} (heuristic; README 기준으로 교정 가능)`,
    );
  }
  if (input.vibecodingToolSlugs.length > 0) {
    lines.push(`바이브코딩 도구 마커: ${input.vibecodingToolSlugs.join(", ")}`);
  }
  lines.push(`README 존재: ${input.hasReadme ? "yes" : "no"}`);
  lines.push(`package.json 존재: ${input.hasPackageJson ? "yes" : "no"}`);

  if (input.readmeSections) {
    lines.push("");
    lines.push("README 섹션 발췌:");
    lines.push(input.readmeSections);
  } else {
    lines.push("");
    lines.push("(README 본문 없음 — 메타데이터 기준으로만 평가)");
  }

  lines.push("");
  lines.push("다음 기준으로 평가하고 JSON으로 응답:");
  lines.push("- documentation: 1-5, README 구조/설치 가이드/스크린샷 언급 품질");
  lines.push("- code_health_readme: 1-5, README에서 추론 가능한 품질 시그널 (주석/예제/구조 설명)");
  lines.push("- category: 아래 enum에서 1개");
  lines.push("- feature_tags_canonical: 아래 30개 슬러그 중 해당 항목만");
  lines.push(
    "- feature_tags_novel: 리포가 제공하는 기능 중 위 30개에 없는 신규 슬러그 (소문자 snake_case)",
  );
  lines.push(
    "- evidence_strength: 'strong' (Features + Getting Started 섹션 모두 존재), 'partial' (둘 중 하나), 'weak' (둘 다 없음)",
  );

  return lines.join("\n");
}

function buildResponseSchema(): object {
  // IMPORTANT: per-axis field order puts `value` BEFORE `rationale` so the
  // numeric score isn't conditioned on post-hoc prose (Flash-Lite is
  // sensitive to field-generation order).
  return {
    type: "object",
    properties: {
      documentation: {
        type: "object",
        properties: {
          value: { type: "integer", minimum: 1, maximum: 5 },
          rationale: { type: "string" },
        },
        required: ["value", "rationale"],
      },
      code_health_readme: {
        type: "object",
        properties: {
          value: { type: "integer", minimum: 1, maximum: 5 },
          rationale: { type: "string" },
        },
        required: ["value", "rationale"],
      },
      category: { type: "string", enum: [...CATEGORIES] },
      feature_tags_canonical: {
        type: "array",
        items: { type: "string", enum: [...SEED_FEATURE_TAG_SLUGS] },
      },
      feature_tags_novel: {
        type: "array",
        items: { type: "string" },
      },
      evidence_strength: { type: "string", enum: ["strong", "partial", "weak"] },
    },
    required: [
      "documentation",
      "code_health_readme",
      "category",
      "feature_tags_canonical",
      "feature_tags_novel",
      "evidence_strength",
    ],
  };
}
