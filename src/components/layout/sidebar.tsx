"use client";

import { Link } from "@/lib/client/nav";
import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { cn } from "@/lib/utils";
import {
  Aperture,
  Bot,
  FileArchive,
  History,
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
 * into the Printify Studio, the Mockups page or the agent. A new page here
 * should replace one of these, not extend the list.
 */
const NAV: NavGroup[] = [
  {
    label: "Create",
    items: [
      { href: "/mockups", label: "Mockups", icon: <Shapes className="h-4 w-4" /> },
      { href: "/printify-studio", label: "Printify Studio", icon: <Shirt className="h-4 w-4" /> },
    ],
  },
  {
    label: "More",
    items: [
      { href: "/agent", label: "Agent", icon: <Bot className="h-4 w-4" /> },
      { href: "/export", label: "Export Center", icon: <FileArchive className="h-4 w-4" /> },
      { href: "/activity", label: "Activity", icon: <History className="h-4 w-4" /> },
      { href: "/settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" /> },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-[212px] shrink-0 flex-col border-r border-border-subtle bg-surface">
      <Link href="/printify-studio" className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-forest text-white">
          <Aperture className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-tight text-ink">Mockup Studio</div>
          <div className="text-[10px] text-ink-subtle">print-on-demand workspace</div>
        </div>
      </Link>
      <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {NAV.map((group) => (
          <div key={group.label} className="mb-3">
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                    active
                      ? "bg-sage-soft text-forest"
                      : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-border-subtle px-4 py-2.5 text-[11px] text-ink-subtle">
        Local workspace · v0.1
      </div>
    </aside>
  );
}
