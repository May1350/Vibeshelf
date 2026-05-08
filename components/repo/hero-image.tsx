"use client";

import Image from "next/image";
import { useState } from "react";

interface HeroImageProps {
  src: string | null | undefined;
  alt: string;
  isAboveFold?: boolean;
  unoptimized?: boolean;
  /**
   * Tailwind aspect-ratio class applied to the wrapper. Cards default to
   * `aspect-[4/3]` for a uniform grid; the detail page override is
   * `aspect-video` for a wider hero. Card thumbnails were previously
   * unconstrained, producing ratios from 1:1 to 5.5:1 across the grid.
   */
  aspectClass?: string;
  className?: string;
  sizes?: string;
}

/**
 * Image with a graceful fallback: if the underlying URL fails to load
 * (broken README image, dead CDN host, optimizer error), render a soft
 * gradient placeholder in the same aspect-ratio box so the grid keeps
 * its rhythm. README extraction can pick deploy buttons / contributor
 * widgets / dead links — the denylist in `extractReadmeMedia` filters
 * future ingestion, but ~33% of already-stored hero URLs were broken
 * at the time of the SP#5 review and the only recovery path until the
 * SP#4.5 image mirror is a render-time fallback.
 */
export function HeroImage({
  src,
  alt,
  isAboveFold = false,
  unoptimized = false,
  aspectClass = "aspect-[4/3]",
  className,
  sizes = "(max-width: 1024px) 100vw, 33vw",
}: HeroImageProps) {
  const [errored, setErrored] = useState(false);

  const showFallback = !src || errored;

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br from-muted via-muted/70 to-muted/30 ${aspectClass} ${className ?? ""}`}
    >
      {!showFallback && (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          unoptimized={unoptimized}
          loading={isAboveFold ? "eager" : "lazy"}
          fetchPriority={isAboveFold ? "auto" : "low"}
          className="object-cover"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}
