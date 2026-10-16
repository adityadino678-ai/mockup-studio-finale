"use client";

import { AppShell } from "@/components/layout/app-shell";
import { TemplatesPage } from "@/views/templates-page";

export function TemplatesRoute() {
  return (
    <AppShell>
      <TemplatesPage />
    </AppShell>
  );
}
