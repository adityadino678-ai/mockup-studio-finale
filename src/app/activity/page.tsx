"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { History } from "lucide-react";

const TYPE_LABELS: Record<string, { label: string; variant: "default" | "muted" | "danger" | "warning" }> = {
  "design.upload": { label: "Upload", variant: "default" },
  "design.delete": { label: "Delete", variant: "danger" },
  "design.update": { label: "Update", variant: "muted" },
  "mockup.upload": { label: "Upload", variant: "default" },
  "mockup.delete": { label: "Delete", variant: "danger" },
  "placement.save": { label: "Editor", variant: "muted" },
  "batch.start": { label: "Batch", variant: "default" },
  "batch.item": { label: "Batch", variant: "muted" },
  "bgremoval.run": { label: "Bg removal", variant: "default" },
  "ink.variant": { label: "Ink variant", variant: "muted" },
  "template.apply": { label: "Template", variant: "muted" },
  "export.run": { label: "Export", variant: "default" },
  "product.create": { label: "Product", variant: "default" },
  "listing.submit": { label: "Listing", variant: "default" },
  "integration.test": { label: "Integration", variant: "muted" },
  error: { label: "Error", variant: "danger" },
};

export default function ActivityPage() {
  const activity = useLiveQuery(
    () => db.activity.orderBy("createdAt").reverse().limit(200).toArray(),
    [],
  );

  return (
    <div className="mx-auto max-w-3xl p-8">
      <PageHeader
        title="Activity"
        description="A log of everything that happened in this workspace. The most recent 2,000 events are kept."
      />
      {!activity ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-surface-muted" />
          ))}
        </div>
      ) : activity.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No activity yet"
          description="Actions like uploads, placements, batches and exports will be recorded here."
        />
      ) : (
        <Card>
          <CardContent className="p-2">
            <ul>
              {activity.map((rec) => {
                const meta = TYPE_LABELS[rec.type] ?? { label: rec.type, variant: "muted" as const };
                return (
                  <li
                    key={rec.id}
                    className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-surface-muted"
                  >
                    <Badge variant={meta.variant} className="w-[92px] justify-center shrink-0">
                      {meta.label}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={rec.message}>
                      {rec.message}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-subtle">
                      {formatDateTime(rec.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
