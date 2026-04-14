import Link from "next/link";

export default function NotFound() {
  return (
    <main className="container mx-auto px-4 py-12 text-center">
      <h1 className="text-3xl font-bold">Repository not found</h1>
      <p className="mt-2 text-muted-foreground">
        This template may have been removed, made private, or never indexed.
      </p>
      <Link href="/" className="inline-block mt-6 text-primary underline">
        ← Back to marketplace
      </Link>
    </main>
  );
}
