"use client";

import { AppShell } from "@/components/layout/app-shell";
import { BatchStudioPage } from "@/views/batch-page";

export function BatchRoute() {
  return (
    <AppShell>
      <BatchStudioPage />
    </AppShell>
  );
}
