import { GitFork } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";

export async function ForkCtaPlaceholder({ githubUrl }: { githubUrl: string }) {
  const t = await getTranslations("repo");
  return (
    <div className="flex flex-col gap-2">
      <Button
        nativeButton={false}
        size="lg"
        variant="default"
        render={
          <a href={githubUrl} target="_blank" rel="noopener noreferrer">
            <GitFork className="mr-2 h-4 w-4" /> {t("viewOnGithub")}
          </a>
        }
      />
      <p className="text-xs text-muted-foreground">{t("fork.comingSoon")}</p>
    </div>
  );
}
