"use client";

import * as React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, FileText, Image as ImageIcon, Layers, X } from "lucide-react";
import { db } from "@/lib/db/schema";

interface ArtifactRailProps {
  onClose(): void;
}

const STATUS_TONE: Record<string, string> = {
  done: "text-forest",
  complete: "text-forest",
  running: "text-warning",
  packing: "text-warning",
  verifying: "text-warning",
  queued: "text-ink-subtle",
  error: "text-danger",
  failed: "text-danger",
};

function Row({
  href,
  icon,
  title,
  meta,
  tone,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  meta: string;
  tone?: string;
}) {
  return (
    <a
      href={href}
      className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] text-ink-muted hover:bg-surface-muted hover:text-ink"
    >
      <span className="mt-0.5 shrink-0 text-ink-subtle">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className={`block text-[10px] ${tone ?? "text-ink-subtle"}`}>{meta}</span>
      </span>
    </a>
  );
}

/**
 * Right-hand rail listing the real artifacts this workspace holds. It reads
 * IndexedDB live, so entries appear the moment a job, export, or draft exists.
 */
export function ArtifactRail({ onClose }: ArtifactRailProps) {
  const jobs = useLiveQuery(() => db.batchJobs.orderBy("createdAt").reverse().limit(5).toArray(), [], []);
  const drafts = useLiveQuery(() => db.listingDrafts.orderBy("updatedAt").reverse().limit(5).toArray(), [], []);
  const exports = useLiveQuery(() => db.exports.orderBy("createdAt").reverse().limit(5).toArray(), [], []);
  const renders = useLiveQuery(() => db.assets.where("kind").equals("mockup-render").count(), [], 0);

  const empty = !jobs.length && !drafts.length && !exports.length && renders === 0;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-border-subtle bg-surface">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        <Layers className="h-3.5 w-3.5 text-ink-subtle" />
        <div className="text-[12px] font-semibold text-ink">Workspace</div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-ink-subtle hover:bg-surface-muted hover:text-ink"
          title="Hide"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto p-2">
        {empty && (
          <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-subtle">
            Nothing here yet. Renders, batch jobs, exports, and listing drafts you create will show up in this rail.
          </p>
        )}

        {jobs.length > 0 && (
          <section className="mb-3">
            <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">Batch jobs</h3>
            {jobs.map((job) => (
              <Row
                key={job.id}
                href="/batch"
                icon={<Layers className="h-3.5 w-3.5" />}
                title={job.name}
                meta={job.status}
                tone={STATUS_TONE[job.status]}
              />
            ))}
          </section>
        )}

        {exports.length > 0 && (
          <section className="mb-3">
            <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">Exports</h3>
            {exports.map((job) => (
              <Row
                key={job.id}
                href="/export"
                icon={<Download className="h-3.5 w-3.5" />}
                title={job.name}
                meta={`${job.files.length} files · ${job.status}`}
                tone={STATUS_TONE[job.status]}
              />
            ))}
          </section>
        )}

        {drafts.length > 0 && (
          <section className="mb-3">
            <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">Listing drafts</h3>
            {drafts.map((draft) => (
              <Row
                key={draft.id}
                href="/listings"
                icon={<FileText className="h-3.5 w-3.5" />}
                title={draft.title || "Untitled draft"}
                meta={`${draft.tags.length} tags · ${draft.status}`}
                tone={STATUS_TONE[draft.status]}
              />
            ))}
          </section>
        )}

        <section className="mb-3">
          <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-subtle">Renders</h3>
          <Row
            href="/batch"
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={`${renders} mockup render${renders === 1 ? "" : "s"}`}
            meta="stored in this browser"
          />
        </section>
      </div>
    </aside>
  );
}
