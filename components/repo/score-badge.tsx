import { Star } from "lucide-react";
import { type ScoreTier, scoreTier } from "@/lib/marketplace/score-tier";

const TIER_COLORS: Record<ScoreTier, string> = {
  Excellent: "text-yellow-500",
  Good: "text-green-500",
  Fair: "text-blue-500",
  Limited: "text-muted-foreground",
};

export function ScoreBadge({ score }: { score: number }) {
  const tier = scoreTier(score);
  return (
    <div
      role="img"
      aria-label={`Quality score ${score.toFixed(1)} of 5, ${tier}`}
      className="inline-flex items-center gap-1 text-sm"
    >
      <Star className={`h-4 w-4 ${TIER_COLORS[tier]}`} aria-hidden="true" />
      <span className="font-semibold">{score.toFixed(1)}</span>
      <span className="text-xs text-muted-foreground">/5 · {tier}</span>
    </div>
  );
}
