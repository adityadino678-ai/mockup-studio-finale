"use client";

import { AppShell } from "@/components/layout/app-shell";
import { MockupsPage } from "@/views/mockups-page";

export function MockupsRoute() {
  return (
    <AppShell>
      <MockupsPage />
    </AppShell>
  );
}
