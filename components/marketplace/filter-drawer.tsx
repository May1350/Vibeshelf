"use client";

import { Filter } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { MarketplaceFacets } from "@/lib/marketplace/facets";
import type { MarketplaceQuery } from "@/lib/marketplace/search-params";
import { FilterSidebar } from "./filter-sidebar";

interface FilterDrawerProps {
  initial: MarketplaceQuery;
  facets: MarketplaceFacets;
}

function countActiveFilters(initial: MarketplaceQuery): number {
  let n = 0;
  if (initial.q) n += 1;
  if (initial.category) n += 1;
  if (typeof initial.min_score === "number") n += 1;
  if (initial.vibecoding) n += 1;
  n += initial.tags.length;
  return n;
}

/**
 * Mobile filter drawer. Wraps `<FilterSidebar>` in a shadcn `<Sheet>` so the
 * same form and progressive-enhancement semantics apply on touch devices.
 *
 * The trigger button is sticky on mobile, hidden at lg+ where the inline
 * sidebar renders instead. `aria-expanded` is bound to the Sheet open state
 * and a Badge shows the active filter count.
 */
export function FilterDrawer({ initial, facets }: FilterDrawerProps) {
  const [open, setOpen] = useState(false);
  const activeCount = countActiveFilters(initial);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            className="sticky top-2 z-10 lg:hidden"
            aria-expanded={open ? "true" : "false"}
          >
            <Filter aria-hidden="true" />
            <span>Filters</span>
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-1">
                {activeCount}
              </Badge>
            )}
          </Button>
        }
      />
      <SheetContent side="bottom" className="h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>
            Narrow the marketplace by category, quality, tool, and tags.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <FilterSidebar initial={initial} facets={facets} className="w-full" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
