"use client";

import * as React from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/primitives";
import { AgentLauncher } from "@/components/agent/agent-launcher";

/**
 * The app chrome. It lives here as a plain React component rather than in
 * `AppLayout.astro` because the page views need React context from
 * `TooltipProvider` — Astro islands cannot nest, so the shell and the view
 * must render inside a single React tree.
 *
 * The agent is one launcher, mounted once. It renders only on the two pages
 * that own a composer (Listing details and Printify Studio) and picks its
 * surface from the pathname.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="scroll-thin flex-1 overflow-y-auto">{children}</main>
      </div>
      <AgentLauncher />
      <Toaster />
    </TooltipProvider>
  );
}
