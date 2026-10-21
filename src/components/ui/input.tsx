import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-ink shadow-subtle transition-colors",
        "placeholder:text-ink-subtle",
        "focus-visible:border-forest focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-subtle transition-colors",
        "placeholder:text-ink-subtle",
        "focus-visible:border-forest focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn("text-[13px] font-medium text-ink leading-none select-none", className)}
      {...props}
    />
  );
}

/**
 * A label that is bound to its control.
 *
 * `Label` alone does not name a control: a Radix label that is not associated
 * with a form element leaves screen readers announcing "slider" or "spin
 * button" with nothing else. Pass `htmlFor` (and the matching `id` on the
 * input) to make the pair explicit.
 */
function FieldLabel({
  htmlFor,
  className,
  children,
}: {
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <LabelPrimitive.Root htmlFor={htmlFor} className={cn("text-[12px] text-ink-muted", className)}>
      {children}
    </LabelPrimitive.Root>
  );
}

export { Input, Textarea, Label, FieldLabel };
