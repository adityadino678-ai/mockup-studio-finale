"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ExportCenterPage } from "@/views/export-page";

export function ExportRoute() {
  return (
    <AppShell>
      <ExportCenterPage />
    </AppShell>
  );
}
