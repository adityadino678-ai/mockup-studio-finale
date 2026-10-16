"use client";

import { AppShell } from "@/components/layout/app-shell";
import { EditorPage } from "@/views/editor-page";

export function EditorRoute() {
  return (
    <AppShell>
      <EditorPage />
    </AppShell>
  );
}
