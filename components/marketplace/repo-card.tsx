"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ScoreBadge } from "@/components/repo/score-badge";
import { Badge } from "@/components/ui/badge";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";

export function RepoCard({
  repo,
  isAboveFold,
}: {
  repo: MarketplaceRepoRow;
  isAboveFold: boolean;
}) {
  const t = useTranslations("repo.card");
  const href = `/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const heroUrl = repo.hero_asset?.external_url ?? null;
  return (
    <article className="relative group rounded-lg overflow-hidden border bg-card hover:shadow-md transition-shadow">
      <Link href={href} className="block focus:outline focus:outline-2 focus:outline-ring">
        {heroUrl ? (
          <Image
            src={heroUrl}
            alt={t("preview", { owner: repo.owner, name: repo.name })}
            width={400}
            height={300}
            unoptimized={repo.hero_asset?.kind === "readme_gif"}
            loading={isAboveFold ? "eager" : "lazy"}
            fetchPriority={isAboveFold ? "auto" : "low"}
            className="w-full h-auto bg-muted"
          />
        ) : (
          <div
            className="aspect-[4/3] bg-gradient-to-br from-muted to-muted/50"
            aria-hidden="true"
          />
        )}
        <div className="p-3 space-y-2">
          <h3 className="font-medium line-clamp-2">
            <span className="text-muted-foreground font-normal">{repo.owner}/</span>
            {repo.name}
          </h3>
          <div className="flex items-center gap-3 text-sm">
            {repo.total_score !== null && <ScoreBadge score={repo.total_score} />}
            <span className="text-muted-foreground">⭐ {formatStars(repo.stars)}</span>
          </div>
          {repo.feature_tags.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label={t("topFeatures")}>
              {repo.feature_tags.slice(0, 3).map((slug) => (
                <li key={slug}>
                  <Badge variant="secondary">{slug}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Link>
      {/* Hover overlay — desktop hover only, hidden on touch (Moderate R1.M1) */}
      {repo.description && (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-black/70 text-white p-4 opacity-0 transition-opacity
                     hover:opacity-100 hidden [@media(hover:hover)]:[&]:block pointer-events-none"
        >
          <p className="text-sm line-clamp-6">{repo.description}</p>
        </div>
      )}
    </article>
  );
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}
