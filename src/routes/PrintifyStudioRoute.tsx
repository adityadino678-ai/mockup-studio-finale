"use client";

import { AppShell } from "@/components/layout/app-shell";
import { PrintifyStudioPage } from "@/views/printify-studio-page";

export function PrintifyStudioRoute() {
  return (
    <AppShell>
      <PrintifyStudioPage />
    </AppShell>
  );
}
