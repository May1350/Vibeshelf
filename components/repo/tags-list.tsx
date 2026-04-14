import { Badge } from "@/components/ui/badge";

interface TagsByKind {
  feature: string[];
  tech_stack: string[];
  vibecoding_tool: string[];
}

const KIND_LABELS: Record<keyof TagsByKind, string> = {
  feature: "Features",
  tech_stack: "Tech Stack",
  vibecoding_tool: "Vibecoding Tools",
};

export function TagsList({ tags }: { tags: TagsByKind }) {
  const sections = (Object.keys(KIND_LABELS) as Array<keyof TagsByKind>).filter(
    (kind) => tags[kind].length > 0,
  );
  if (sections.length === 0) return null;
  return (
    <section aria-labelledby="tags-heading" className="space-y-3">
      <h2 id="tags-heading" className="text-lg font-semibold">
        Tags
      </h2>
      {sections.map((kind) => (
        <div key={kind}>
          <h3 className="text-sm text-muted-foreground mb-1">{KIND_LABELS[kind]}</h3>
          <ul className="flex flex-wrap gap-1">
            {tags[kind].map((slug) => (
              <li key={slug}>
                <Badge variant="secondary">{slug}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
