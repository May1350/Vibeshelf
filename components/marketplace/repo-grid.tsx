"use client";

import Masonry from "react-masonry-css";
import type { MarketplaceRepoRow } from "@/lib/marketplace/queries";
import { RepoCard } from "./repo-card";

const ABOVE_FOLD_COUNT = 8;

const breakpointCols = {
  default: 4,
  1280: 3,
  768: 2,
  640: 1,
};

export function RepoGrid({ repos }: { repos: MarketplaceRepoRow[] }) {
  return (
    <Masonry
      breakpointCols={breakpointCols}
      className="flex gap-4"
      columnClassName="flex flex-col gap-4"
    >
      {repos.map((repo, i) => (
        <RepoCard key={repo.id} repo={repo} isAboveFold={i < ABOVE_FOLD_COUNT} />
      ))}
    </Masonry>
  );
}
