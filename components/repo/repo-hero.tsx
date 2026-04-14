import Image from "next/image";
import type { RepoDetail } from "@/lib/marketplace/queries";
import { ForkCtaPlaceholder } from "./fork-cta-placeholder";

export function RepoHero({ repo }: { repo: RepoDetail }) {
  const githubUrl = `https://github.com/${repo.owner}/${repo.name}`;
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        {repo.hero_asset?.external_url && (
          <Image
            src={repo.hero_asset.external_url}
            alt={`${repo.owner}/${repo.name} preview`}
            width={1200}
            height={675}
            unoptimized={repo.hero_asset.kind === "readme_gif"}
            priority
            className="w-full rounded-lg border"
          />
        )}
      </div>
      <aside className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="text-muted-foreground font-normal">{repo.owner} /</span> {repo.name}
        </h1>
        {repo.description && <p className="text-muted-foreground">{repo.description}</p>}
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">License</dt>
          <dd className="font-mono">{repo.license}</dd>
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
