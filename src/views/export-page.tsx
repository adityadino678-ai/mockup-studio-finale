"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { db } from "@/lib/db/schema";
import { designMainAssetId } from "@/lib/db/repo";
import { buildExportArchive, pruneOldExports, recordExportJob } from "@/lib/export/zip-export";
import { uid, logActivity } from "@/lib/db/repo";
import type { ExportJob, ExportSelection } from "@/types/domain";
import { PageHeader } from "@/components/layout/page-header";
import { AssetThumb } from "@/components/asset-thumb";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox, Progress } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import { Download, FileArchive, Loader2, Trash2, TriangleAlert } from "lucide-react";

type Phase = "idle" | "collecting" | "packing" | "verifying" | "done" | "error";

export function ExportCenterPage() {
  const designs = useLiveQuery(() => db.designs.orderBy("name").toArray(), []);
  const jobs = useLiveQuery(() => db.exports.orderBy("createdAt").reverse().toArray(), []);

  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [opts, setOpts] = React.useState({
    includeMain: true,
    includeWhiteInk: true,
    includeBlackInk: true,
    includeMockupRenders: true,
    includeListings: true,
  });
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progressInfo, setProgressInfo] = React.useState({ done: 0, total: 0, current: "" });
  const [lastResult, setLastResult] = React.useState<{ files: number; missing: string[]; errors: string[]; url: string; name: string } | null>(null);

  React.useEffect(() => {
    void pruneOldExports();
  }, []);

  const toggle = (id: string) =>
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const runExport = async () => {
    if (selectedIds.length === 0) return;
    setPhase("collecting");
    setLastResult(null);
    const jobId = uid();
    const job: ExportJob = {
      id: jobId,
      name: `Export ${new Date().toLocaleString()}`,
      selection: { designIds: selectedIds, ...opts } as ExportSelection,
      status: "packing",
      files: [],
      missingAssets: [],
      createdAt: Date.now(),
    };
    await recordExportJob(job);

    try {
      const result = await buildExportArchive(job.selection, (info) => {
        setPhase(info.phase);
        setProgressInfo({ done: info.done, total: info.total, current: info.current ?? "" });
      });
      const name = `MockupStudio_Export_${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(result.blob);
      setLastResult({ files: result.fileCount, missing: result.missingAssets, errors: result.errors, url, name });
      await recordExportJob({
        ...job,
        status: result.errors.length > 0 ? "failed" : "completed",
        files: [],
        missingAssets: result.missingAssets,
        error: result.errors.length > 0 ? result.errors.join("; ") : undefined,
        finishedAt: Date.now(),
      });
      await logActivity(
        "export.run",
        `Exported ${result.fileCount} files for ${selectedIds.length} design${selectedIds.length > 1 ? "s" : ""}`,
        { jobId },
      );
      setPhase("done");
      if (result.errors.length === 0) {
        toast.success(`Archive ready — ${result.fileCount} files verified`);
      } else {
        toast.error("Archive built but failed verification");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Export failed";
      await recordExportJob({ ...job, status: "failed", error: message, finishedAt: Date.now() });
      setPhase("error");
      toast.error(message);
    }
  };

  const download = () => {
    if (!lastResult) return;
    const a = document.createElement("a");
    a.href = lastResult.url;
    a.download = lastResult.name;
    a.click();
  };

  const busy = phase === "collecting" || phase === "packing" || phase === "verifying";

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader
        title="Export Center"
        description="Download your work as an organized ZIP archive with a manifest."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-[14px]">Designs to export</CardTitle>
          </CardHeader>
          <CardContent>
            {!designs ? (
              <div className="h-20 animate-pulse rounded-md bg-surface-muted" />
            ) : designs.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-ink-muted">
                Upload designs first — exports are organized per design.
              </p>
            ) : (
              <>
                <div className="scroll-thin max-h-[280px] space-y-1 overflow-y-auto pr-1">
                  {designs.map((d) => (
                    <label key={d.id} className="flex cursor-pointer items-center gap-3 rounded-md p-1.5 hover:bg-surface-muted">
                      <Checkbox checked={selectedIds.includes(d.id)} onCheckedChange={() => toggle(d.id)} />
                      <AssetThumb assetId={designMainAssetId(d)} className="h-11 w-11 shrink-0 rounded-md" checkerboard />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-ink">{d.name}</div>
                        <div className="text-[11px] text-ink-subtle">
                          {d.whiteInkAssetId ? "white ink " : ""}
                          {d.blackInkAssetId ? "black ink " : ""}
                          {!d.whiteInkAssetId && !d.blackInkAssetId ? "no ink variants" : ""}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-2 text-[12px]">
                  <Button variant="ghost" size="sm" onClick={() => setSelectedIds(designs.map((d) => d.id))}>
                    Select all
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
                    Clear
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-[14px]">Include</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {(
              [
                ["includeMain", "Original design"],
                ["includeWhiteInk", "White ink variant"],
                ["includeBlackInk", "Black ink variant"],
                ["includeMockupRenders", "Generated mockups"],
                ["includeListings", "Listing text + JSON"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
                <span>{label}</span>
                <Checkbox checked={opts[key]} onCheckedChange={(v) => setOpts((o) => ({ ...o, [key]: !!v }))} />
              </label>
            ))}
            <Separator className="my-3" />
            <Button className="w-full" disabled={selectedIds.length === 0 || busy} onClick={runExport}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileArchive className="h-3.5 w-3.5" />}
              {busy
                ? phase === "verifying"
                  ? "Verifying archive…"
                  : phase === "packing"
                    ? "Packing ZIP…"
                    : "Collecting files…"
                : `Build ZIP (${selectedIds.length})`}
            </Button>
            {busy && (
              <div className="space-y-1">
                <Progress value={progressInfo.total ? (progressInfo.done / progressInfo.total) * 100 : 0} />
                <div className="truncate text-[11px] text-ink-subtle">
                  {progressInfo.current || `${progressInfo.done} of ${progressInfo.total}`}
                </div>
              </div>
            )}
            {lastResult && (
              <div className="space-y-2 rounded-md border border-border-subtle p-2.5">
                <div className="text-[13px] font-medium text-ink">{lastResult.files} files verified</div>
                {lastResult.errors.length > 0 && (
                  <div className="text-[12px] text-danger">{lastResult.errors.join(" ")}</div>
                )}
                {lastResult.missing.length > 0 && (
                  <div className="text-[12px] text-warning">
                    {lastResult.missing.length} missing: {lastResult.missing.slice(0, 2).join(", ")}
                    {lastResult.missing.length > 2 ? "…" : ""}
                  </div>
                )}
                <Button size="sm" className="w-full" onClick={download}>
                  <Download className="h-3.5 w-3.5" /> Download ZIP
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-[15px] font-semibold text-ink">Structure</h2>
      <Card>
        <CardContent className="pt-4">
          <pre className="overflow-x-auto text-[12px] leading-relaxed text-ink-muted">{`MockupStudio_Export/
├── manifest.json
├── Design_A/
│   ├── original.png
│   ├── white-ink.png        (when it exists)
│   ├── black-ink.png        (when it exists)
│   ├── mockups/
│   │   ├── 01-t-shirt-front.png
│   │   └── 02-hoodie-back.png
│   └── listing/
│       ├── listing.json
│       └── description.txt`}</pre>
        </CardContent>
      </Card>

      <h2 className="mb-3 mt-8 text-[15px] font-semibold text-ink">Export history</h2>
      {!jobs ? (
        <div className="h-14 animate-pulse rounded-md bg-surface-muted" />
      ) : jobs.length === 0 ? (
        <EmptyState icon={<FileArchive />} title="No exports yet" description="Build your first archive above." />
      ) : (
        <Card>
          <CardContent className="p-2">
            <ul>
              {jobs.map((job) => (
                <li key={job.id} className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-surface-muted">
                  <Badge
                    variant={job.status === "completed" ? "forest" : job.status === "failed" ? "danger" : "muted"}
                  >
                    {job.status}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{job.name}</div>
                    <div className="text-[11px] text-ink-subtle">
                      {formatDateTime(job.createdAt)} · {job.selection.designIds.length} designs
                      {job.missingAssets.length > 0 && ` · ${job.missingAssets.length} missing`}
                    </div>
                    {job.error && (
                      <div className="flex items-center gap-1 text-[11px] text-danger">
                        <TriangleAlert className="h-3 w-3" /> {job.error}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Delete record"
                    onClick={() => db.exports.delete(job.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}