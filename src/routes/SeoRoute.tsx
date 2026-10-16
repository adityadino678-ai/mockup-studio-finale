"use client";

import { AppShell } from "@/components/layout/app-shell";
import { SeoStudioPage } from "@/views/seo-page";

export function SeoRoute() {
  return (
    <AppShell>
      <SeoStudioPage />
    </AppShell>
  );
}
