import { getTranslations } from "next-intl/server";

export async function ReviewsPlaceholder() {
  const t = await getTranslations("repo.reviews");
  return (
    <section aria-labelledby="reviews-heading" className="space-y-2">
      <h2 id="reviews-heading" className="text-lg font-semibold">
        {t("heading")}
      </h2>
      <p className="text-muted-foreground">{t("placeholder")}</p>
    </section>
  );
}
