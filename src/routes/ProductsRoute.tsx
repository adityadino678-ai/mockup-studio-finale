"use client";

import { AppShell } from "@/components/layout/app-shell";
import { ProductBuilderPage } from "@/views/products-page";

export function ProductsRoute() {
  return (
    <AppShell>
      <ProductBuilderPage />
    </AppShell>
  );
}
