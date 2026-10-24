"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ListingImagesView } from "@/views/listings/listing-images-view";

export function ListingImagesRoute() {
  return (
    <AppShell>
      <ListingImagesView />
    </AppShell>
  );
}
