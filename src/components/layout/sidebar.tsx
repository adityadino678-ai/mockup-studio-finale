"use client";

import { Link } from "@/lib/client/nav";
import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { cn } from "@/lib/utils";
import { getSetting, setSetting } from "@/lib/db/schema";
import {
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
  const [collapsed, setCollapsed] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth < 640,
  );

  // Expanded on a first visit; a saved choice wins after that. The read is
  // async, so the rail renders expanded for one frame rather than flashing a
  // collapsed bar on every navigation. Small screens start collapsed so page
  // content keeps a usable width; the user can still expand and have a choice
  // saved for later.
  React.useEffect(() => {
    let live = true;
    void getSetting<boolean>(COLLAPSE_KEY, false).then((saved) => {
      if (live && (saved === true || window.innerWidth < 640)) setCollapsed(true);
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
        "flex h-full shrink-0 flex-col border-r-2 border-ink bg-paper transition-[width] duration-200",
        collapsed ? "w-16" : "w-[232px]",
      )}
    >
      <div className={cn("border-b border-ink/20", collapsed ? "px-2 py-4" : "px-4 py-5")}>
        <Link
          href="/"
          className={cn("flex items-center", collapsed ? "justify-center" : "gap-2.5")}
          title="ListBulkly home"
          aria-label="ListBulkly home"
        >
          {collapsed ? (
            <span className="flex h-9 w-9 items-center justify-center border-2 border-ink bg-ink text-lg font-bold leading-none text-orange">
              L
            </span>
          ) : (
            <div className="leading-none">
              <div className="text-[18px] font-bold uppercase tracking-[0.14em] text-ink">
                List<span className="text-orange">/</span>Bulkly
              </div>
              <div className="mt-1.5 font-hand text-[16px] leading-none text-blue">
                from sketch to shelf
              </div>
            </div>
          )}
        </Link>
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-3" aria-label="Workspace">
        {NAV.map((group) => (
          <div key={group.label} className="mb-2">
            {collapsed ? (
              <div className="mx-auto my-3 h-0.5 w-6 bg-ink/30" aria-hidden />
            ) : (
              <div className="px-2 pb-1.5 pt-4 text-[10px] font-bold uppercase tracking-[0.2em] text-ink-subtle">
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
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "mb-1 flex items-center border-l-2 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors",
                    collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-2.5 py-2",
                    active
                      ? "border-orange bg-wash text-ink"
                      : "border-transparent text-ink-muted hover:border-ink hover:bg-surface-muted hover:text-ink",
                  )}
                >
                  <span className="[&_svg]:h-4 [&_svg]:w-4">{item.icon}</span>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={cn("border-t-2 border-ink", collapsed ? "p-2" : "p-3")}>
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-expanded={!collapsed}
          className={cn(
            "flex w-full items-center border border-ink bg-paper py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-ink transition-colors hover:bg-wash",
            collapsed ? "justify-center px-0" : "gap-2 px-2",
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
        {!collapsed && (
          <>
            <Link
              href="/"
              className="mt-2 flex items-center justify-between px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-subtle hover:text-blue"
            >
              <span>Public page</span>
              <span aria-hidden>↗</span>
            </Link>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 px-1 text-[9px] font-bold uppercase tracking-[0.12em] text-ink-subtle">
              <Link href="/?auth=in" className="hover:text-blue">
                Log in
              </Link>
              <Link href="/privacy" className="hover:text-blue">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-blue">
                Terms
              </Link>
              <Link href="/refunds" className="hover:text-blue">
                Refunds
              </Link>
              <Link href="/cookies" className="hover:text-blue">
                Cookies
              </Link>
              <Link href="/contact" className="hover:text-blue">
                Contact
              </Link>
            </div>
            <div className="mt-2 px-1 text-[9px] font-bold uppercase tracking-[0.16em] text-ink-subtle">
              Local-first · account optional
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
