"use client";

import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { Sparkles } from "lucide-react";

/**
 * Floating launcher for the agent chat. The full experience lives on `/agent`
 * (see `views/agent-page.tsx`); this is just the entry point and is hidden while
 * the agent page itself is open.
 */
export function AssistantPanel() {
  const pathname = usePathname();
  if (pathname.startsWith("/agent")) return null;
  return (
    <a
      href="/agent"
      className="fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-forest text-white shadow-pop transition-transform hover:scale-105"
      title="Open the agent"
      aria-label="Open the agent"
    >
      <Sparkles className="h-5 w-5" />
    </a>
  );
}
