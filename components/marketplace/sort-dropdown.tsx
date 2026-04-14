"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MarketplaceQuery } from "@/lib/marketplace/search-params";

interface SortDropdownProps {
  initial: MarketplaceQuery["sort"];
}

/**
 * Sort dropdown for the marketplace grid. Controlled by URL: changing the
 * value constructs a fresh `/?...` URL, resets `page=1`, and pushes with
 * `scroll: false` so the user doesn't get yanked back to the top.
 *
 * "Most Reviewed" is disabled with a "Coming soon" Badge — we'll light it up
 * once the reviews subsystem lands.
 */
export function SortDropdown({ initial }: SortDropdownProps) {
  const router = useRouter();
  const params = useSearchParams();

  function onChange(next: string | null) {
    if (!next) return;
    const url = new URLSearchParams(params.toString());
    url.set("sort", next);
    url.set("page", "1");
    router.push(`/?${url.toString()}`, { scroll: false });
  }

  return (
    <Select value={initial} onValueChange={onChange}>
      <SelectTrigger className="w-56" aria-label="Sort by">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="score">Best (quality + stars)</SelectItem>
        <SelectItem value="recent">Recently updated</SelectItem>
        <SelectItem value="popular">Popular (age-normalized)</SelectItem>
        <SelectItem value="reviewed" disabled>
          <span>Most Reviewed</span>
          <Badge variant="secondary" className="ml-2">
            Coming soon
          </Badge>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
