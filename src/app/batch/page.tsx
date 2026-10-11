"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { cancelBatchJob, createBatchJob, deleteBatchJob, recoverStaleJobs, retryBatchItem, runBatchJob } from "@/lib/batch/runner";
import { designMainAssetId } from "@/lib/db/repo";
import { useDesignSelection } from "@/lib/store/selection";
import type { BatchItem, BatchJob, InkVariant } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox, Progress, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/primitives";
import { relativeTime } from "@/lib/utils";
import { CircleCheck, CircleX, Clock, Loader2, Layers, RotateCcw, Trash2, X } from "lucide-react";

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "muted" | "danger" | "warning" | "forest" }> = {
  queued: { label: "queued", variant: "muted" },
  running: { label: "running", variant: "warning" },
  completed: { label: "completed", variant: "forest" },
  "completed-with-errors": { label: "done with errors", variant: "warning" },
  cancelled: { label: "cancelled", variant: "muted" },
  failed: { label: "failed", variant: "danger" },
  pending: { label: "pending", variant: "muted" },
  processing: { label: "processing", variant: "warning" },
  done: { label: "done", variant: "forest" },
};

export default function BatchStudioPage() {
  const preselectedDesigns = useDesignSelection((s) => s.selectedDesignIds);

  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const mockups = useLiveQuery(() => db.mockups.orderBy("name").toArray(), []);
  const jobs = useLiveQuery(() => db.batchJobs.orderBy("createdAt").reverse().toArray(), []);
  const placementTemplates = useLiveQuery(() => db.templates.where("category").equals("placement").toArray(), []);

  const [selectedDesignIds, setSelectedDesignIds] = React.useState<string[]>([]);
  const [selectedMockupIds, setSelectedMockupIds] = React.useState<string[]>([]);
  const [variantRule, setVariantRule] = React.useState<InkVariant>("main");
  const concurrency = 2;
  const [skipExisting, setSkipExisting] = React.useState(true);
  const [placementTemplateId, setPlacementTemplateId] = React.useState<string>("none");
  const [starting, setStarting] = React.useState(false);

  // Carry over selections made on the Designs / Mockups pages.
  React.useEffect(() => {
    if (preselectedDesigns.length > 0) setSelectedDesignIds(preselectedDesigns);
  }, [preselectedDesigns]);

  // Mark jobs that were interrupted by a page reload as retryable failures.
  React.useEffect(() => {
    void recoverStaleJobs();
  }, []);

  const comboCount = selectedDesignIds.length * selectedMockupIds.length;

  const toggleDesign = (id: string) =>
    setSelectedDesignIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const toggleMockup = (id: string) =>
    setSelectedMockupIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const handleStart = async () => {
    if (comboCount === 0) return;
    setStarting(true);
    try {
      const { jobId, total, reused } = await createBatchJob({
        designIds: selectedDesignIds,
        mockupIds: selectedMockupIds,
        variantRule,
        variantOverrides: {},
        concurrency,
        placementTemplateId: placementTemplateId === "none" ? undefined : placementTemplateId,
        skipExisting,
      });
      toast.success(`Job created: ${total} combinations${reused > 0 ? ` (${reused} reused existing renders)` : ""}`);
      await runBatchJob(jobId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start batch");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Batch Studio"
        description="Generate every design × mockup combination in one job with live status and per-item retries."
      />

      {/* --- Job configuration --- */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-[14px]">Designs</CardTitle>
          </CardHeader>
          <CardContent>
            {designs && designs.length === 0 ? (
              <p className="text-[13px] text-ink-muted">No designs yet — upload some in the Designs section.</p>
            ) : (
              <div className="scroll-thin max-h-[280px] space-y-1 overflow-y-auto pr-1">
                {designs?.map((d) => (
                  <label key={d.id} className="flex cursor-pointer items-center gap-2.5 rounded-md p-1.5 hover:bg-surface-muted">
                    <Checkbox
                      checked={selectedDesignIds.includes(d.id)}
                      onCheckedChange={() => toggleDesign(d.id)}
                    />
                    <AssetThumb assetId={designMainAssetId(d)} className="h-10 w-10 shrink-0 rounded-md" checkerboard />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
                  </label>
                ))}
              </div>
            )}
            {selectedDesignIds.length > 0 && (
              <div className="mt-2 text-[12px] text-ink-muted">{selectedDesignIds.length} selected</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[14px]">Mockups</CardTitle>
          </CardHeader>
          <CardContent>
            {mockups && mockups.length === 0 ? (
              <p className="text-[13px] text-ink-muted">No mockups yet — upload some in the Mockups section.</p>
            ) : (
              <div className="scroll-thin max-h-[280px] space-y-1 overflow-y-auto pr-1">
                {mockups?.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2.5 rounded-md p-1.5 hover:bg-surface-muted">
                    <Checkbox
                      checked={selectedMockupIds.includes(m.id)}
                      onCheckedChange={() => toggleMockup(m.id)}
                    />
                    <AssetThumb assetId={m.assetId} className="h-10 w-10 shrink-0 rounded-md bg-surface-muted" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{m.name}</span>
                  </label>
                ))}
              </div>
            )}
            {selectedMockupIds.length > 0 && (
              <div className="mt-2 text-[12px] text-ink-muted">{selectedMockupIds.length} selected</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[14px]">Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3.5">
            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-ink-muted">Ink variant for all designs</div>
              <Select value={variantRule} onValueChange={(v) => setVariantRule(v as InkVariant)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">Main design</SelectItem>
                  <SelectItem value="white">White ink (where created)</SelectItem>
                  <SelectItem value="black">Black ink (where created)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-ink-subtle">
                Designs without the chosen variant fall back to their main artwork.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-ink-muted">Placement</div>
              <Select value={placementTemplateId} onValueChange={setPlacementTemplateId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Saved placement per pair (default)</SelectItem>
                  {placementTemplates?.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>Template: {tpl.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-ink-subtle">
                Pairs with a saved editor placement use it; others use the template or centered defaults.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ink-muted">Processing mode</span>
              </div>
              <p className="text-[11px] leading-relaxed text-ink-subtle">
                Renders run one at a time in the browser, yielding between items so the interface stays
                responsive and per-item status is always accurate.
              </p>
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
              <span>Skip existing renders</span>
              <Checkbox checked={skipExisting} onCheckedChange={(v) => setSkipExisting(!!v)} />
            </label>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-ink">
                  {selectedDesignIds.length} × {selectedMockupIds.length} = {comboCount}
                </div>
                <div className="text-[11px] text-ink-subtle">combinations{skipExisting ? " (existing renders reused)" : ""}</div>
              </div>
              <Button size="sm" disabled={comboCount === 0 || starting} onClick={handleStart}>
                {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
                Start job
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* --- Jobs --- */}
      <h2 className="mb-3 text-[15px] font-semibold text-ink">Jobs</h2>
      {!jobs ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-md bg-surface-muted" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No batch jobs yet"
          description="Select designs and mockups above, then start a job. You'll see live per-item status here."
        />
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job }: { job: BatchJob }) {
  const items = useLiveQuery(() => db.batchItems.where("jobId").equals(job.id).toArray(), [job.id]);
  const designRecords = useLiveQuery(() => db.designs.toArray(), []);
  const mockupRecords = useLiveQuery(() => db.mockups.toArray(), []);

  const counts = React.useMemo(() => {
    const base = { done: 0, failed: 0, pending: 0, processing: 0, cancelled: 0 };
    items?.forEach((i) => {
      base[i.status] = (base[i.status] ?? 0) + 1;
    });
    return base;
  }, [items]);

  const total = items?.length ?? 0;
  const finished = counts.done + counts.failed + counts.cancelled;
  const statusMeta = STATUS_BADGE[job.status] ?? { label: job.status, variant: "muted" as const };
  const isRunning = job.status === "running" || job.status === "queued";

  const designName = (id: string) => designRecords?.find((d) => d.id === id)?.name ?? "—";
  const mockupName = (id: string) => mockupRecords?.find((m) => m.id === id)?.name ?? "—";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{job.name}</CardTitle>
            <div className="text-[12px] text-ink-muted">
              {relativeTime(job.createdAt)} · {total} combinations · {counts.done} done
              {counts.failed > 0 && `, ${counts.failed} failed`}
              {counts.cancelled > 0 && `, ${counts.cancelled} cancelled`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
            {isRunning && (
              <Button size="sm" variant="outline" onClick={() => cancelBatchJob(job.id)}>
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            {job.status === "completed-with-errors" && counts.failed > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const failed = items?.filter((i) => i.status === "failed") ?? [];
                  for (const f of failed) {
                    await retryBatchItem(job.id, f.id);
                  }
                }}
                title="Retry all failed items"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Retry failed
              </Button>
            )}
            {!isRunning && (
              <Button size="sm" variant="ghost" onClick={() => deleteBatchJob(job.id)} title="Delete job record">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Progress value={total > 0 ? (finished / total) * 100 : 0} className="h-1" />
          <span className="w-[70px] shrink-0 text-right text-[11px] text-ink-subtle">
            {finished}/{total}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {items && items.length > 0 && (
          <div className="scroll-thin max-h-[220px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-subtle">
                  <th className="pb-1.5 font-medium">Design</th>
                  <th className="pb-1.5 font-medium">Mockup</th>
                  <th className="pb-1.5 font-medium">Status</th>
                  <th className="pb-1.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    designName={designName(item.designId)}
                    mockupName={mockupName(item.mockupId)}
                    onRetry={() => retryBatchItem(job.id, item.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ItemRow({
  item,
  designName,
  mockupName,
  onRetry,
}: {
  item: BatchItem;
  designName: string;
  mockupName: string;
  onRetry: () => void;
}) {
  const meta = STATUS_BADGE[item.status] ?? { label: item.status, variant: "muted" as const };
  const icon =
    item.status === "done" ? <CircleCheck className="h-3.5 w-3.5 text-forest" /> :
    item.status === "failed" ? <CircleX className="h-3.5 w-3.5 text-danger" /> :
    item.status === "processing" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" /> :
    item.status === "cancelled" ? <X className="h-3.5 w-3.5 text-ink-subtle" /> :
    <Clock className="h-3.5 w-3.5 text-ink-subtle" />;

  return (
    <tr className="border-t border-border-subtle">
      <td className="py-1.5 pr-2">{designName}</td>
      <td className="py-1.5 pr-2">{mockupName}</td>
      <td className="py-1.5 pr-2">
        <span className="flex items-center gap-1.5">
          {icon}
          <Badge variant={meta.variant}>{meta.label}</Badge>
          {item.note && <span className="text-ink-subtle">· {item.note}</span>}
          {item.error && <span className="text-danger">· {item.error}</span>}
        </span>
      </td>
      <td className="py-1.5 text-right">
        {(item.status === "failed" || item.status === "cancelled") && (
          <Button variant="ghost" size="icon-sm" onClick={onRetry} title="Retry this item">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
        {item.status === "done" && item.outputAssetId && (
          <AssetThumb assetId={item.outputAssetId} className="ml-auto h-9 w-9 rounded border border-border-subtle" />
        )}
      </td>
    </tr>
  );
}
