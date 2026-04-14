// Score → tier text, used by ScoreBadge for non-color encoding (a11y per Real R2.R8).
export type ScoreTier = "Excellent" | "Good" | "Fair" | "Limited";

export function scoreTier(score: number): ScoreTier {
  if (score >= 4.5) return "Excellent";
  if (score >= 3.5) return "Good";
  if (score >= 2.5) return "Fair";
  return "Limited";
}
