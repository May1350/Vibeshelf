import { GridSkeleton } from "@/components/marketplace/grid-skeleton";

export default function Loading() {
  return (
    <main className="container mx-auto px-4 py-6">
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <GridSkeleton />
      </div>
    </main>
  );
}
