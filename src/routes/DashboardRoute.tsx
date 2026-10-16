"use client";

import { AppShell } from "@/components/layout/app-shell";
import { OverviewPage } from "@/views/dashboard-page";

export function DashboardRoute() {
  return (
    <AppShell>
      <OverviewPage />
    </AppShell>
  );
}
