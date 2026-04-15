import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";
import { RepoGrid } from "./repo-grid";

export async function EmptyState({ recommendations }: { recommendations: MarketplaceRepoRow[] }) {
  const t = await getTranslations("marketplace.grid.noResults");
  return (
    <section role="status" aria-labelledby="no-results-heading" className="text-center py-12">
      <h2 id="no-results-heading" className="text-2xl font-semibold">
        {t("heading")}
      </h2>
      <p className="mt-2 text-muted-foreground">{t("hint")}</p>
      <div className="mt-4">
        <Link href="/" className="text-primary underline">
          {t("clearAllFilters")}
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
