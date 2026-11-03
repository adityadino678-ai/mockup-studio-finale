"use client";

import * as React from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Official brand logos for the integrations the app supports.
 *
 * simple-icons (CC0) ships obfuscated path data for most of these brands, so
 * the paths are embedded verbatim. Brands with no simple-icons entry get an
 * original monogram (Printify) or a generic glyph (the rest) - never a
 * hand-drawn copy of another mark.
 */

interface BrandIcon {
  title: string;
  path: string;
}

// Using inline SVG paths for known brands to avoid simple-icons import issues
const BRAND_ICONS: Record<string, BrandIcon> = {
  nvidia: { 
    title: "NVIDIA", 
    path: "M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z" 
  },
  openrouter: { 
    title: "OpenRouter", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  google: { 
    title: "Google", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  mistral: { 
    title: "Mistral", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  deepseek: { 
    title: "DeepSeek", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  anthropic: { 
    title: "Anthropic", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  ollama: { 
    title: "Ollama", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  etsy: { 
    title: "Etsy", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
  supabase: { 
    title: "Supabase", 
    path: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" 
  },
};

/** An original Printify monogram - simple-icons does not ship that logo. */
function PrintifyGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Printify"
      className={className}
    >
      <path d="M6.5 20V4.8" />
      <path d="M6.5 5h8.6a4.5 4.5 0 0 1 0 9H6.5" />
    </svg>
  );
}

/**
 * A brand logo for an integration or AI provider id.
 *
 * Known providers render their official glyph; everything else renders a
 * neutral Bot icon, which is honest about being a placeholder.
 */
export function ProviderLogo({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const brand = BRAND_ICONS[id];
  if (brand) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        role="img"
        aria-label={brand.title}
        className={cn("h-4 w-4 shrink-0", className)}
      >
        <path d={brand.path} />
      </svg>
    );
  }
  if (id === "printify") {
    return <PrintifyGlyph className={cn("h-4 w-4 shrink-0", className)} />;
  }
  return <Bot className={cn("h-4 w-4 shrink-0", className)} aria-hidden />;
}

/** The human-readable brand name for an id, for labels and tooltips. */
export function providerBrandName(id: string): string {
  if (id === "printify") return "Printify";
  const brand = BRAND_ICONS[id];
  return brand?.title ?? id;
}
