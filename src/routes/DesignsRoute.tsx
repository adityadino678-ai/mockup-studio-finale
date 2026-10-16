"use client";

import { AppShell } from "@/components/layout/app-shell";
import { DesignsPage } from "@/views/designs-page";

export function DesignsRoute() {
  return (
    <AppShell>
      <DesignsPage />
    </AppShell>
  );
}
