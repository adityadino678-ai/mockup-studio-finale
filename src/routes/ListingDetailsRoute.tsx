"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ListingDetailsView } from "@/views/listings/listing-details-view";

export function ListingDetailsRoute() {
  return (
    <AppShell>
      <ListingDetailsView />
    </AppShell>
  );
}
