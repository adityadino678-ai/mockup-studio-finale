"use client";

import * as React from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { relativeTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ArrowRight,
  FileArchive,
  Images,
  Layers,
  PenTool,
  Shapes,
  Sparkles,
} from "lucide-react";

function StatCard({
  label,
  value,
  icon,
  href,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  href: string;
}) {
  return (
    <Link href={href} className="group">
      <Card className="transition-colors group-hover:border-sage-deep">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sage-soft text-forest [&_svg]:h-4 [&_svg]:w-4">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-xl font-semibold leading-none text-ink">{value}</div>
            <div className="mt-1 truncate text-[12px] text-ink-muted">{label}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

interface WorkflowStep {
  title: string;
  description: string;
  href: string;
  cta: string;
  icon: React.ReactNode;
}

const WORKFLOW: WorkflowStep[] = [
  {
    title: "1. Upload your designs",
    description: "PNG, JPEG or WebP artwork. Everything is stored locally and survives refreshes.",
    href: "/designs",
    cta: "Open Designs",
    icon: <Images className="h-4 w-4" />,
  },
  {
    title: "2. Add mockup photos",
    description: "Upload photos of t-shirts, hoodies, mugs and more, organized by product type.",
    href: "/mockups",
    cta: "Open Mockups",
    icon: <Shapes className="h-4 w-4" />,
  },
  {
    title: "3. Place artwork in the editor",
    description: "Move, resize, rotate and flip your artwork on a mockup, then save or save as template.",
    href: "/editor",
    cta: "Open Editor",
    icon: <PenTool className="h-4 w-4" />,
  },
  {
    title: "4. Batch generate",
    description: "Combine every design with every mockup in one job with live status and retries.",
    href: "/batch",
    cta: "Open Batch Studio",
    icon: <Layers className="h-4 w-4" />,
  },
  {
    title: "5. Export as ZIP",
    description: "Download an organized archive with originals, ink variants, renders and a manifest.",
    href: "/export",
    cta: "Open Export Center",
    icon: <FileArchive className="h-4 w-4" />,
  },
];

export default function OverviewPage() {
  const designs = useLiveQuery(() => db.designs.count(), [], 0);
  const mockups = useLiveQuery(() => db.mockups.count(), [], 0);
  const jobs = useLiveQuery(() => db.batchJobs.toArray(), []);
  const exports = useLiveQuery(() => db.exports.toArray(), []);
  const templates = useLiveQuery(() => db.templates.count(), [], 0);
  const recent = useLiveQuery(
    () => db.activity.orderBy("createdAt").reverse().limit(8).toArray(),
    [],
  );

  const loaded = !(
    designs === undefined ||
    mockups === undefined ||
    jobs === undefined ||
    exports === undefined ||
    templates === undefined ||
    recent === undefined
  );

  const completedJobs = jobs?.filter((j) => j.status.startsWith("completed")).length ?? 0;
  const completedExports = exports?.filter((e) => e.status === "completed").length ?? 0;
  const isEmpty = loaded && designs === 0 && mockups === 0;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader
        title="Overview"
        description="Your local print-on-demand workspace."
        actions={
          <Button asChild>
            <Link href="/designs">
              <Sparkles className="h-4 w-4" />
              Start a workflow
            </Link>
          </Button>
        }
      />

      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="h-9 w-full animate-pulse rounded-md bg-surface-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState
          icon={<Sparkles />}
          title="Welcome to Mockup Studio"
          description="Upload your first design to begin. Everything runs locally in your browser — no accounts, no API keys required for the core workflow."
          actions={[
            {
              label: "Upload designs",
              icon: <Images className="h-3.5 w-3.5" />,
              onClick: () => (window.location.href = "/designs"),
            },
            {
              label: "Add mockups",
              icon: <Shapes className="h-3.5 w-3.5" />,
              onClick: () => (window.location.href = "/mockups"),
            },
          ]}
          className="mb-6"
        />
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Designs" value={designs} icon={<Images />} href="/designs" />
          <StatCard label="Mockups" value={mockups} icon={<Shapes />} href="/mockups" />
          <StatCard label="Batch jobs done" value={completedJobs} icon={<Layers />} href="/batch" />
          <StatCard label="Exports done" value={completedExports} icon={<FileArchive />} href="/export" />
          <StatCard label="Templates" value={templates} icon={<ArrowRight />} href="/templates" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>The workflow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {WORKFLOW.map((step) => (
              <Link
                key={step.title}
                href={step.href}
                className="group flex items-start gap-3 rounded-md p-2.5 transition-colors hover:bg-surface-muted"
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sage-soft text-forest [&_svg]:h-4 [&_svg]:w-4">
                  {step.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{step.title}</div>
                  <div className="text-[12px] leading-relaxed text-ink-muted">{step.description}</div>
                </div>
                <ArrowRight className="mt-2 h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-forest" />
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!loaded ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-8 animate-pulse rounded-md bg-surface-muted" />
                ))}
              </div>
            ) : recent && recent.length > 0 ? (
              <ul className="space-y-0.5">
                {recent.map((rec) => (
                  <li key={rec.id} className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-muted">
                    <span className="min-w-0 truncate text-ink">{rec.message}</span>
                    <span className="shrink-0 text-[11px] text-ink-subtle">{relativeTime(rec.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-6 text-center text-[13px] text-ink-muted">
                Nothing yet — your actions will appear here.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
