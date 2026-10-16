"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ActivityPage } from "@/views/activity-page";

export function ActivityRoute() {
  return (
    <AppShell>
      <ActivityPage />
    </AppShell>
  );
}
