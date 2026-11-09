"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-4",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-blue">
          <span className="inline-block h-2.5 w-2.5 bg-orange" aria-hidden />
          ListBulkly workspace
        </div>
        <h1 className="text-[26px] leading-[1.05] text-ink sm:text-[30px]">{title}</h1>
        {description && (
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
