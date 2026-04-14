import { GitFork } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ForkCtaPlaceholder({ githubUrl }: { githubUrl: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Button
        nativeButton={false}
        size="lg"
        variant="default"
        render={
          <a href={githubUrl} target="_blank" rel="noopener noreferrer">
            <GitFork className="mr-2 h-4 w-4" /> View on GitHub
          </a>
        }
      />
      <p className="text-xs text-muted-foreground">
        One-click Fork available after sign-in (coming soon).
      </p>
    </div>
  );
}
