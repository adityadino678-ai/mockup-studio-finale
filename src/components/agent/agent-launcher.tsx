"use client";

// ---------------------------------------------------------------------------
// The agent launcher.
//
// A floating button, bottom-right, on exactly two pages: Listing details and
// Printify Studio. Clicking it opens the panel IN PLACE - it never navigates,
// because the agent works on the page you are already looking at.
//
// The open state is remembered PER PAGE, so leaving Listing details and coming
// back finds the panel the way you left it, and the Studio's panel state does
// not leak into it.
// ---------------------------------------------------------------------------

import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { getSetting, setSetting } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { AgentPanel } from "@/components/agent/agent-panel";
import { Sparkles, X } from "lucide-react";

/** The pages that own an agent panel. */
const AGENT_PAGES: Array<{ prefix: string; surface: "listing" | "studio" }> = [
  { prefix: "/listing-details", surface: "listing" },
  { prefix: "/printify-studio", surface: "studio" },
];

/** Which surface the current path belongs to, if any. */
function surfaceFor(pathname: string): "listing" | "studio" | undefined {
  for (const page of AGENT_PAGES) {
    if (pathname === page.prefix || pathname.startsWith(`${page.prefix}/`)) return page.surface;
  }
  return undefined;
}

/** Where the panel's open state is remembered. */
function openKey(surface: "listing" | "studio"): string {
  return `agent:panelOpen:${surface}`;
}

export function AgentLauncher() {
  const pathname = usePathname();
  const surface = surfaceFor(pathname);
  const [open, setOpen] = React.useState(false);

  // The open state is per surface, so it is read when the surface changes.
  React.useEffect(() => {
    if (!surface) {
      setOpen(false);
      return;
    }
    let live = true;
    void getSetting<boolean>(openKey(surface), false).then((saved) => {
      if (live) setOpen(saved === true);
    });
    return () => {
      live = false;
    };
  }, [surface]);

  const toggle = React.useCallback(() => {
    if (!surface) return;
    setOpen((value) => {
      const next = !value;
      void setSetting(openKey(surface), next);
      return next;
    });
  }, [surface]);

  if (!surface) return null;

  return (
    <>
      {/* The panel slides in over the page; the page underneath is untouched. */}
      <div
        className={cn(
          "pointer-events-none fixed bottom-20 right-5 z-40 transition-transform duration-200",
          open ? "translate-x-0 opacity-100" : "translate-x-6 opacity-0",
        )}
        aria-hidden={!open}
      >
        <div className="pointer-events-auto h-[540px] w-[380px] max-w-[calc(100vw-2rem)]">
          {open && <AgentPanel surface={surface} onClose={toggle} />}
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-label={open ? "Close the agent" : "Open the agent"}
        aria-expanded={open}
        data-agent-launcher={surface}
        className={cn(
          "fixed bottom-5 right-5 z-50 flex h-11 w-11 items-center justify-center rounded-full shadow-pop transition-colors",
          open
            ? "bg-forest text-white hover:bg-forest-deep"
            : "bg-surface text-forest ring-1 ring-border-strong hover:bg-surface-muted",
        )}
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>
    </>
  );
}
