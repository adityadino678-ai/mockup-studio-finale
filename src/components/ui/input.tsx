import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-none border-2 border-ink bg-paper px-3 py-1 text-base text-ink transition-colors",
        "placeholder:text-ink-muted",
        "focus-visible:border-blue",
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
        "flex min-h-[80px] w-full rounded-none border-2 border-ink bg-paper px-3 py-2 text-base text-ink transition-colors",
        "placeholder:text-ink-muted",
        "focus-visible:border-blue",
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
      className={cn(
        "select-none text-xs font-bold uppercase leading-none tracking-wide text-ink",
        className,
      )}
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
    <LabelPrimitive.Root
      htmlFor={htmlFor}
      className={cn(
        "text-xs font-bold uppercase tracking-wide text-ink-muted",
        className,
      )}
    >
      {children}
    </LabelPrimitive.Root>
  );
}

export { Input, Textarea, Label, FieldLabel };
