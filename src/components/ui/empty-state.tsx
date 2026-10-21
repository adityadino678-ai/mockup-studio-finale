import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  variant?: "default" | "outline" | "secondary";
}

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  actions?: EmptyStateAction[];
  className?: string;
}

export function EmptyState({ icon, title, description, actions, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface/60 px-6 py-14 text-center",
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sage-soft text-forest [&_svg]:h-5 [&_svg]:w-5">
        {icon}
      </div>
      <div className="space-y-1">
        {/* h2, not h3: the empty state sits directly under the page's h1 and
            skipping a level breaks heading navigation. */}
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>
      </div>
      {actions && actions.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) => (
            <Button key={action.label} variant={action.variant ?? "outline"} size="sm" onClick={action.onClick}>
              {action.icon}
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
