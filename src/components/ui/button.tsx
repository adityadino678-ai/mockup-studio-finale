import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-none text-[11px] font-bold uppercase tracking-[0.12em] transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-2 border-ink bg-ink text-paper hover:border-orange hover:bg-orange hover:text-ink",
        sage: "border-2 border-ink bg-wash text-ink hover:bg-blue hover:text-paper",
        secondary:
          "border border-ink/40 bg-surface-muted text-ink hover:border-ink hover:bg-wash",
        outline: "border-2 border-ink bg-transparent text-ink hover:bg-wash",
        ghost:
          "border-2 border-transparent text-ink-muted hover:border-ink hover:bg-surface-muted hover:text-ink",
        destructive:
          "border-2 border-orange bg-orange text-ink hover:border-ink hover:bg-ink hover:text-paper",
        link: "text-blue underline decoration-2 underline-offset-4 hover:text-orange",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-[10px]",
        lg: "h-11 px-5 text-[12px]",
        icon: "h-8 w-8 px-0",
        "icon-sm": "h-7 w-7 px-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
