import { licenseLabel } from "@/lib/marketplace/labels";
import type { RepoDetail } from "@/lib/marketplace/queries";
import { ForkCtaPlaceholder } from "./fork-cta-placeholder";
import { HeroImage } from "./hero-image";

export function RepoHero({ repo }: { repo: RepoDetail }) {
  const githubUrl = `https://github.com/${repo.owner}/${repo.name}`;
  // Detail layout: image takes 2 columns at lg+ but should still collapse to
  // single-column on small screens. The wrapper enforces the column span; the
  // HeroImage provides the aspect-ratio + onError fallback so a missing or
  // dead README hero no longer leaves the left half empty (Reviewer A P1#8).
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        <HeroImage
          src={repo.hero_asset?.external_url}
          alt={`${repo.owner}/${repo.name} preview`}
          isAboveFold
          unoptimized={repo.hero_asset?.kind === "readme_gif"}
          aspectClass="aspect-video"
          className="rounded-lg border"
          sizes="(max-width: 1024px) 100vw, 66vw"
        />
      </div>
      <aside className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="text-muted-foreground font-normal">{repo.owner} /</span> {repo.name}
        </h1>
        {repo.description && <p className="text-muted-foreground">{repo.description}</p>}
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">License</dt>
          <dd className="font-mono">{licenseLabel(repo.license)}</dd>
          <dt className="text-muted-foreground">Stars</dt>
          <dd>{repo.stars.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Forks</dt>
          <dd>{repo.forks.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Last commit</dt>
          <dd>{new Date(repo.last_commit_at).toLocaleDateString()}</dd>
        </dl>
        <ForkCtaPlaceholder githubUrl={githubUrl} />
      </aside>
    </section>
  );
}
