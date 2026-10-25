"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { usePathname } from "@/lib/client/nav";
import { db } from "@/lib/db/schema";
import {
  pauseAutopilotRun,
  resumeActiveRuns,
  resumeAutopilotRun,
} from "@/lib/autopilot/runner";
import type { AutopilotRun } from "@/types/autopilot";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Loader2,
  Pause,
  Play,
  Workflow,
} from "lucide-react";

/**
 * The background-process tab.
 *
 * A run lives in IndexedDB, so this dock can pick it up on any page. It is the
 * reason navigating away is safe: the new document calls `resumeActiveRuns()`
 * and continues from the persisted stage instead of losing the job.
 */
export function TaskDock() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const runs = useLiveQuery(
    () => db.autopilotRuns.orderBy("updatedAt").reverse().limit(5).toArray(),
    [],
    undefined,
  );
  const run = runs?.[0];

  React.useEffect(() => {
    void resumeActiveRuns().catch(() => {
      // The dock is chrome; a failed resume is shown by the run itself.
    });
  }, []);

  // The full page owns the run on `/autopilot`; the dock would duplicate it.
  if (!run || pathname.startsWith("/autopilot")) return null;

  const total = run.listings.length;
  const published = run.listings.filter((listing) => listing.status === "published").length;
  const active = run.status === "running";
  const needsReview = run.status === "needs-review";

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "fixed bottom-4 left-[224px] z-40 w-[320px] rounded-lg border border-border-subtle bg-surface shadow-pop",
        open ? "" : "w-auto",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Autopilot background task"
      >
        <StatusIcon run={run} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            Autopilot
            <span className="truncate font-normal text-ink-muted">· {run.query}</span>
          </span>
          <span className="block truncate text-[11px] text-ink-subtle">
            {statusLine(run)} · {published}/{total} published
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        )}
      </button>

      {open && (
        <div className="border-t border-border-subtle px-3 py-2.5">
          <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-forest transition-all"
              style={{ width: `${total ? (published / total) * 100 : 0}%` }}
            />
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {run.listings.slice(0, 6).map((listing) => (
              <span
                key={listing.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                  listing.status === "published"
                    ? "bg-sage-soft text-forest"
                    : listing.status === "failed"
                      ? "bg-danger-soft text-danger"
                      : "bg-surface-muted text-ink-muted",
                )}
                title={`${listing.designName}: ${listing.status}`}
              >
                {listing.designName}
              </span>
            ))}
            {total > 6 && (
              <span className="text-[10px] text-ink-subtle">+{total - 6} more</span>
            )}
          </div>
          <div className="mb-2 max-h-24 space-y-1 overflow-y-auto">
            {[...run.log]
              .reverse()
              .slice(0, 3)
              .map((entry) => (
                <div key={entry.id} className="truncate text-[10px] text-ink-subtle">
                  {entry.message}
                </div>
              ))}
          </div>
          <div className="flex items-center gap-1.5">
            {active ? (
              <button
                type="button"
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-muted disabled:opacity-50"
                onClick={() => void act(() => pauseAutopilotRun(run.id))}
              >
                <Pause className="h-3 w-3" /> Pause
              </button>
            ) : run.status === "paused" ? (
              <button
                type="button"
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-muted disabled:opacity-50"
                onClick={() => void act(() => resumeAutopilotRun(run.id))}
              >
                <Play className="h-3 w-3" /> Resume
              </button>
            ) : null}
            {needsReview && (
              <span className="text-[11px] text-warning">Waiting for your review</span>
            )}
            <a
              href={`/autopilot?run=${encodeURIComponent(run.id)}`}
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-forest px-2 py-1 text-[11px] font-medium text-white hover:bg-forest-deep"
            >
              Open <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ run }: { run: AutopilotRun }) {
  if (run.status === "running") {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-forest" />;
  }
  if (run.status === "completed") {
    return <CircleCheck className="h-4 w-4 shrink-0 text-forest" />;
  }
  if (run.status === "failed") {
    return <CircleAlert className="h-4 w-4 shrink-0 text-danger" />;
  }
  if (run.status === "needs-review" || run.status === "paused") {
    return <CircleAlert className="h-4 w-4 shrink-0 text-warning" />;
  }
  return <Workflow className="h-4 w-4 shrink-0 text-ink-subtle" />;
}

function statusLine(run: AutopilotRun): string {
  switch (run.status) {
    case "running":
      return run.stage === "publishing" ? "Publishing" : "Working in the background";
    case "needs-review":
      return "Needs your review";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Stopped with an error";
    case "cancelled":
      return "Cancelled";
  }
}
