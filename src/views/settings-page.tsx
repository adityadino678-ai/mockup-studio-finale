"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes } from "@/lib/utils";
import { Database, HardDrive, KeyRound, Settings as SettingsIcon } from "lucide-react";

interface IntegrationStatus {
  configured: boolean;
  providerLabel?: string;
  detail?: string;
  checkedAt: number;
}

export function SettingsPage() {
  const [storage, setStorage] = React.useState<{ usage: number; quota: number } | null>(null);
  const [integrations, setIntegrations] = React.useState<Record<string, IntegrationStatus> | null>(null);
  const [integrationsError, setIntegrationsError] = React.useState<string | null>(null);

  const counts = useLiveQuery(async () => {
    const [designs, mockups, assets, renders, templates] = await Promise.all([
      db.designs.count(),
      db.mockups.count(),
      db.assets.count(),
      db.assets.where("kind").equals("mockup-render").count(),
      db.templates.count(),
    ]);
    return { designs, mockups, assets, renders, templates };
  }, []);

  React.useEffect(() => {
    navigator.storage?.estimate?.().then((est) => {
      if (est.usage != null && est.quota != null) {
        setStorage({ usage: est.usage, quota: est.quota });
      }
    });
    fetch("/api/integrations/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setIntegrations)
      .catch((e) => setIntegrationsError(e instanceof Error ? e.message : "Failed to load integration status"));
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <PageHeader title="Settings" description="Workspace storage and external integrations." />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-forest" /> Local storage
          </CardTitle>
          <CardDescription>
            Mockup Studio stores all designs, mockups and generated images in your browser&rsquo;s
            IndexedDB. Nothing is uploaded anywhere.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!counts ? (
            <div className="h-16 animate-pulse rounded-md bg-surface-muted" />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Designs" value={counts.designs} />
              <Stat label="Mockups" value={counts.mockups} />
              <Stat label="Assets" value={counts.assets} />
              <Stat label="Renders" value={counts.renders} />
              <Stat label="Templates" value={counts.templates} />
            </div>
          )}
          <Separator className="my-4" />
          {storage ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[13px]">
                <span className="text-ink-muted">Browser storage used</span>
                <span className="text-ink">
                  {formatBytes(storage.usage)} {storage.quota ? `of ~${formatBytes(storage.quota)}` : ""}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-forest transition-all"
                  style={{ width: `${storage.quota ? Math.min(100, (storage.usage / storage.quota) * 100) : 100}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-ink-muted">Storage estimate unavailable in this browser.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-forest" /> Integrations
          </CardTitle>
          <CardDescription>
            API keys live only in <code className="rounded bg-surface-muted px-1 py-0.5 text-[12px]">.env.local</code> on
            the server. The browser never sees them. Core workflows work without any keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!integrations && !integrationsError && <div className="h-8 animate-pulse rounded-md bg-surface-muted" />}
          {integrationsError && (
            <EmptyState
              icon={<SettingsIcon />}
              title="Could not check integrations"
              description={`The status endpoint failed: ${integrationsError}`}
            />
          )}
          {integrations &&
            Object.entries(integrations).map(([key, st]) => (
              <div key={key} className="flex items-start justify-between gap-3 rounded-md border border-border-subtle p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-medium capitalize text-ink">
                    <Database className="h-3.5 w-3.5 text-ink-subtle" />
                    {key}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{st.detail}</p>
                </div>
                <Badge variant={st.configured ? "default" : "outline"} className="shrink-0">
                  {st.configured ? "configured" : "not configured"}
                </Badge>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-muted px-3 py-2">
      <div className="text-lg font-semibold leading-none text-ink">{value}</div>
      <div className="mt-1 text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}
