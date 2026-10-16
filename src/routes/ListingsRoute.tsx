"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ListingsPage } from "@/views/listings-page";

export function ListingsRoute() {
  return (
    <AppShell>
      <ListingsPage />
    </AppShell>
  );
}
