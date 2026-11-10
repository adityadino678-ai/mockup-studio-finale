"use client";

import { Link } from "@/lib/client/nav";
import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { cn } from "@/lib/utils";
import { getSetting, setSetting } from "@/lib/db/schema";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/primitives";
import {
  CircleHelp,
  ClipboardList,
  Cookie,
  Earth,
  Eye,
  FileArchive,
  History,
  Images,
  LogIn,
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Scale,
  Settings as SettingsIcon,
  Shapes,
  Shirt,
  Shield,
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

/**
 * The footer's "Learn more" menu: every destination that is not part of the
 * working day (the public landing, sign-in and the legal/contact pages), one
 * list for the expanded footer and the collapsed rail. The links are real
 * `Link` documents loads; the menu merely groups them so the footer stays one
 * line instead of seven.
 */
const LEARN_MORE: Array<{ href: string; label: string; icon: React.ReactNode; tail?: string }> = [
  { href: "/", label: "Public page", icon: <Earth className="h-3.5 w-3.5" />, tail: "↗" },
  { href: "/?auth=in", label: "Log in", icon: <LogIn className="h-3.5 w-3.5" /> },
  { href: "/privacy", label: "Privacy", icon: <Shield className="h-3.5 w-3.5" /> },
  { href: "/terms", label: "Terms", icon: <Scale className="h-3.5 w-3.5" /> },
  { href: "/refunds", label: "Refunds", icon: <Receipt className="h-3.5 w-3.5" /> },
  { href: "/cookies", label: "Cookies", icon: <Cookie className="h-3.5 w-3.5" /> },
  { href: "/contact", label: "Contact", icon: <Mail className="h-3.5 w-3.5" /> },
];

/** Sketch styling shared by the two trigger shapes. */
const LEARN_MORE_ITEM_CLASS =
  "block w-full cursor-pointer px-2 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-ink outline-none transition-colors hover:bg-wash focus:bg-wash";

/**
 * One "Learn more" dropdown, opening upward from the expanded footer and to
 * the right from the collapsed rail's icon button.
 */
function LearnMoreMenu({ collapsed }: { collapsed: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Learn more"
          aria-label="Learn more"
          className={cn(
            "flex w-full items-center border border-ink bg-paper py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-ink transition-colors hover:bg-wash",
            collapsed ? "justify-center px-0" : "justify-between gap-2 px-2 py-1.5",
          )}
        >
          <CircleHelp className="h-4 w-4" />
          {!collapsed && <span>Learn more</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={collapsed ? "right" : "top"}
        align={collapsed ? "end" : "start"}
        sideOffset={collapsed ? 8 : 6}
        className="min-w-[10.5rem] p-1"
      >
        {LEARN_MORE.map((item) => (
          <DropdownMenuItem key={item.href} asChild>
            <Link href={item.href} className={LEARN_MORE_ITEM_CLASS}>
              <span className="flex items-center gap-2">
                {item.icon}
                <span>{item.label}</span>
              </span>
              {item.tail && (
                <span aria-hidden className="ml-auto pl-2 text-ink-muted">
                  {item.tail}
                </span>
              )}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="normal-case tracking-normal text-ink-muted">
          Local-first · account optional
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
              <div className="text-[18px] font-bold uppercase tracking-wide text-ink">
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
              <div className="px-2 pb-1.5 pt-4 text-xs font-bold uppercase tracking-wide text-ink-muted">
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
                    "mb-1 flex items-center border-l-2 text-xs font-bold uppercase tracking-wide transition-colors",
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

      <div className={cn("border-t-2 border-ink", collapsed ? "space-y-2 p-2" : "space-y-2 p-3")}>
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-expanded={!collapsed}
          className={cn(
            "flex w-full items-center border border-ink bg-paper py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-ink transition-colors hover:bg-wash",
            collapsed ? "justify-center px-0" : "gap-2 px-2",
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
        <LearnMoreMenu collapsed={collapsed} />
      </div>
    </aside>
  );
}
