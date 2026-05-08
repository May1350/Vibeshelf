import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { tagLabel, vibecodingLabel } from "@/lib/marketplace/labels";

interface TagsByKind {
  feature: string[];
  tech_stack: string[];
  vibecoding_tool: string[];
}

const KINDS: Array<keyof TagsByKind> = ["feature", "tech_stack", "vibecoding_tool"];

function labelFor(kind: keyof TagsByKind, slug: string): string {
  if (kind === "vibecoding_tool") return vibecodingLabel(slug);
  // Tech-stack slugs (react, typescript, …) get the same dictionary path as
  // feature tags. tagLabel() falls back to humanize for unknown slugs, which
  // produces "React"/"Vite" but mis-cases brands like "TypeScript". Acceptable
  // until we add a tech-stack dictionary.
  return tagLabel(slug);
}

export async function TagsList({ tags }: { tags: TagsByKind }) {
  const t = await getTranslations("repo.tagsList");
  const sections = KINDS.filter((kind) => tags[kind].length > 0);
  if (sections.length === 0) return null;
  return (
    <section aria-labelledby="tags-heading" className="space-y-3">
      <h2 id="tags-heading" className="text-lg font-semibold">
        {t("heading")}
      </h2>
      {sections.map((kind) => (
        <div key={kind}>
          <h3 className="text-sm text-muted-foreground mb-1">{t(`kinds.${kind}`)}</h3>
          <ul className="flex flex-wrap gap-1">
            {tags[kind].map((slug) => (
              <li key={slug}>
                <Badge variant="secondary">{labelFor(kind, slug)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
