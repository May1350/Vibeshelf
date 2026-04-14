import Link from "next/link";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";
import { RepoGrid } from "./repo-grid";

export function EmptyState({ recommendations }: { recommendations: MarketplaceRepoRow[] }) {
  return (
    <section role="status" aria-labelledby="no-results-heading" className="text-center py-12">
      <h2 id="no-results-heading" className="text-2xl font-semibold">
        No results found
      </h2>
      <p className="mt-2 text-muted-foreground">
        Try clearing some filters, or browse top-rated templates below:
      </p>
      <div className="mt-4">
        <Link href="/" className="text-primary underline">
          Clear all filters
        </Link>
      </div>
      {recommendations.length > 0 && (
        <div className="mt-8 text-left">
          <RepoGrid repos={recommendations} />
        </div>
      )}
    </section>
  );
}
