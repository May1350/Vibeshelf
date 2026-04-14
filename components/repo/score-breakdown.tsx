import { ScoreBadge } from "./score-badge";

interface ScoreAxes {
  documentation: number;
  code_health: number;
  maintenance: number;
  popularity: number;
  visual_preview: number;
  total: number;
}

const AXIS_LABELS: Record<keyof Omit<ScoreAxes, "total">, string> = {
  documentation: "Documentation",
  code_health: "Code Health",
  maintenance: "Maintenance",
  popularity: "Popularity",
  visual_preview: "Visual Preview",
};

const AXIS_WEIGHTS: Record<keyof Omit<ScoreAxes, "total">, number> = {
  documentation: 0.2,
  code_health: 0.25,
  maintenance: 0.2,
  popularity: 0.15,
  visual_preview: 0.2,
};

export function ScoreBreakdown({ axes }: { axes: ScoreAxes }) {
  const axisKeys = Object.keys(AXIS_LABELS) as Array<keyof typeof AXIS_LABELS>;
  return (
    <section aria-labelledby="score-breakdown-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="score-breakdown-heading" className="text-lg font-semibold">
          Quality breakdown
        </h2>
        <ScoreBadge score={axes.total} />
      </div>
      <dl className="space-y-2">
        {axisKeys.map((key) => {
          const value = axes[key];
          const pct = (value / 5) * 100;
          return (
            <div key={key} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-sm">
              <dt className="text-muted-foreground">
                {AXIS_LABELS[key]}{" "}
                <span className="text-xs">({Math.round(AXIS_WEIGHTS[key] * 100)}%)</span>
              </dt>
              <dd className="bg-muted h-2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${pct}%` }}
                  aria-hidden="true"
                />
              </dd>
              <dd className="font-medium tabular-nums">{value.toFixed(1)}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
