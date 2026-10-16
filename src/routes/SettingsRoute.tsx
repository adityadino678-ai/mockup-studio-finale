"use client";

import { AppShell } from "@/components/layout/app-shell";
import { SettingsPage } from "@/views/settings-page";

export function SettingsRoute() {
  return (
    <AppShell>
      <SettingsPage />
    </AppShell>
  );
}
