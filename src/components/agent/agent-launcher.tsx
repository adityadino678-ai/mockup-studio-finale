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
      {/* The panel slides in over the page; the page underneath is untouched.
          While it is CLOSED the box must not exist for the mouse at all.
          `opacity-0` does not stop hit-testing, and the inner wrapper carries
          `pointer-events-auto`, so an unopened panel used to leave an
          invisible 380x540 block in the bottom-right corner that swallowed
          every click on the page beneath it - the Studio's selection bar
          ("Select all", "Delete") and anything else in that corner simply did
          not respond. `invisible` removes it from hit-testing entirely, and
          pointer-events is only re-enabled while it is actually open. */}
      <div
        className={cn(
          "pointer-events-none fixed bottom-20 right-5 z-40 transition-transform duration-200",
          open ? "visible translate-x-0 opacity-100" : "invisible translate-x-6 opacity-0",
        )}
        aria-hidden={!open}
      >
        <div
          className={cn(
            "h-[540px] w-[380px] max-w-[calc(100vw-2rem)]",
            open ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
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
