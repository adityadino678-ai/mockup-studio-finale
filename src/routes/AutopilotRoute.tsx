"use client";

import { AppShell } from "@/components/layout/app-shell";
import { AutopilotPage } from "@/views/autopilot-page";

export function AutopilotRoute() {
  return (
    <AppShell>
      <AutopilotPage />
    </AppShell>
  );
}
