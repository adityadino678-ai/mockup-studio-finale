import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("border border-ink bg-surface", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("text-[15px] font-bold leading-snug text-ink", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm leading-relaxed text-ink-muted", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center p-4 pt-0", className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-none border px-1.5 py-0.5 text-xs font-bold uppercase leading-tight tracking-[0.12em]",
  {
    variants: {
      variant: {
        default: "border-ink/25 bg-wash text-ink",
        forest: "border-ink bg-ink text-paper",
        outline: "border-ink bg-transparent text-ink",
        danger: "border-orange bg-danger-soft text-ink",
        warning: "border-blue bg-warning-soft text-blue",
        // The muted badge sits on the muted surface, where ink-muted is only
        // 4.4:1 - too low for 11px text. Ink clears it comfortably.
        muted: "border-ink/25 bg-surface-muted text-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

function Separator({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("h-px w-full bg-border-subtle", className)} {...props} />;
}

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-none bg-wash", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Badge, badgeVariants, Separator, Skeleton };
