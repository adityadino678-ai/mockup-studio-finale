"use client";

import { Link } from "@/lib/client/nav";
import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { cn } from "@/lib/utils";
import { getSetting, setSetting } from "@/lib/db/schema";
import {
  Aperture,
  ClipboardList,
  Eye,
  FileArchive,
  History,
  Images,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Shapes,
  Shirt,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The app's pages.
 *
 * Small on purpose: the eight tools that used to sit beside these (the
 * Designs library, the mockup editor, the batch runner, templates, the
 * Product Builder, listings, the SEO studio and the overview) were folded
 * into the Printify Studio, the Mockups page or the agent. The three Listing
 * pages are the one deliberate addition since. Autopilot and the standalone
 * Agent page are gone; the agent is now a panel on the two pages that need it.
 */
const NAV: NavGroup[] = [
  {
    label: "Create",
    items: [
      { href: "/printify-studio", label: "Printify Studio", icon: <Shirt className="h-4 w-4" /> },
      { href: "/mockups", label: "Mockups", icon: <Shapes className="h-4 w-4" /> },
      { href: "/listing-images", label: "Listing images", icon: <Images className="h-4 w-4" /> },
      { href: "/listing-details", label: "Listing details", icon: <ClipboardList className="h-4 w-4" /> },
      { href: "/listing-preview", label: "Listing preview", icon: <Eye className="h-4 w-4" /> },
    ],
  },
  {
    label: "More",
    items: [
      { href: "/export", label: "Export Center", icon: <FileArchive className="h-4 w-4" /> },
      { href: "/activity", label: "Activity", icon: <History className="h-4 w-4" /> },
      { href: "/settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" /> },
    ],
  },
];

/** Where the collapsed rail's choice is remembered. */
const COLLAPSE_KEY = "ui:sidebarCollapsed";

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);

  // Expanded on a first visit; a saved choice wins after that. The read is
  // async, so the rail renders expanded for one frame rather than flashing a
  // collapsed bar on every navigation.
  React.useEffect(() => {
    let live = true;
    void getSetting<boolean>(COLLAPSE_KEY, false).then((saved) => {
      if (live && saved === true) setCollapsed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      void setSetting(COLLAPSE_KEY, next);
      return next;
    });
  }, []);

  return (
    <aside
      data-sidebar-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border-subtle bg-surface transition-[width] duration-200",
        collapsed ? "w-14" : "w-[212px]",
      )}
    >
      <div className={cn("flex items-center", collapsed ? "justify-center px-2 py-4" : "gap-2.5 px-4 py-4")}>
        <Link
          href="/printify-studio"
          className="flex items-center gap-2.5"
          title="Mockup Studio"
          aria-label="Mockup Studio home"
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-forest text-white">
            <Aperture className="h-4 w-4" />
          </div>
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-[14px] font-semibold tracking-tight text-ink">Mockup Studio</div>
              <div className="text-[10px] text-ink-subtle">print-on-demand workspace</div>
            </div>
          )}
        </Link>
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {NAV.map((group) => (
          <div key={group.label} className="mb-3">
            {collapsed ? (
              <div className="mx-auto my-2 h-px w-6 bg-border-subtle" aria-hidden />
            ) : (
              <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={cn(
                    "mb-0.5 flex items-center rounded-md text-[13px] font-medium transition-colors",
                    collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-1.5",
                    active
                      ? "bg-sage-soft text-forest"
                      : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                  )}
                >
                  {item.icon}
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-border-subtle p-2">
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-expanded={!collapsed}
          className={cn(
            "flex w-full items-center rounded-md py-1.5 text-[11px] text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink",
            collapsed ? "justify-center px-0" : "gap-2 px-2",
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
        {!collapsed && (
          <div className="px-2 pt-1 text-[11px] text-ink-subtle">Local workspace · v0.1</div>
        )}
      </div>
    </aside>
  );
}
