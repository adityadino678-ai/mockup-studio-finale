"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ListingPreviewView } from "@/views/listings/listing-preview-view";

export function ListingPreviewRoute() {
  return (
    <AppShell>
      <ListingPreviewView />
    </AppShell>
  );
}
