"use client";

import { AppShell } from "@/components/layout/app-shell";
import { BackgroundRemoverView } from "@/views/background-remover-view";

export function BackgroundRemoverRoute() {
  return (
    <AppShell>
      <BackgroundRemoverView />
    </AppShell>
  );
}
