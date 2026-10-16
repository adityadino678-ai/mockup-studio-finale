"use client";

import { AppShell } from "@/components/layout/app-shell";
import { AgentPage } from "@/views/agent-page";

export function AgentRoute() {
  return (
    <AppShell>
      <AgentPage />
    </AppShell>
  );
}
