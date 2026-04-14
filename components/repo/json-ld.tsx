interface RepoLike {
  owner: string;
  name: string;
  description: string | null;
  total_score?: number | null;
  category: string | null;
  hero_asset?: { external_url: string | null } | null;
}

export function JsonLd({ repo, url }: { repo: RepoLike; url: string }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${repo.owner}/${repo.name}`,
    description: repo.description ?? undefined,
    applicationCategory: repo.category ?? undefined,
    url,
    image: repo.hero_asset?.external_url ?? undefined,
    aggregateRating: repo.total_score
      ? { "@type": "AggregateRating", ratingValue: repo.total_score, bestRating: 5, ratingCount: 1 }
      : undefined,
  };
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted JSON-LD construction
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
