"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { HeroImage } from "@/components/repo/hero-image";
import { ScoreBadge } from "@/components/repo/score-badge";
import { Badge } from "@/components/ui/badge";
import { tagLabel } from "@/lib/marketplace/labels";
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
        <HeroImage
          src={heroUrl}
          alt={t("preview", { owner: repo.owner, name: repo.name })}
          isAboveFold={isAboveFold}
          unoptimized={repo.hero_asset?.kind === "readme_gif"}
          aspectClass="aspect-[4/3]"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
        />
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
                  <Badge variant="secondary">{tagLabel(slug)}</Badge>
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
