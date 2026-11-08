import * as React from "react";
import { cn } from "@/lib/utils";

type CommonProps = {
  variant?: "solid" | "outline";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
  className?: string;
  children?: React.ReactNode;
};

type ButtonProps = CommonProps &
  Omit<React.ComponentProps<"button">, keyof CommonProps> & {
    href?: undefined;
  };

type AnchorProps = CommonProps &
  Omit<React.ComponentProps<"a">, keyof CommonProps> & {
    href: string;
  };

/** Solid ink rectangle that turns orange and tilts slightly on hover. */
export function SketchButton(props: ButtonProps | AnchorProps) {
  const {
    variant = "solid",
    size = "md",
    block = false,
    loading = false,
    className,
    children,
    ...rest
  } = props;

  const classes = cn(
    "sk-btn",
    variant === "outline" && "sk-btn--outline",
    size === "sm" && "sk-btn--sm",
    size === "lg" && "sk-btn--lg",
    block && "sk-btn--block",
    className,
  );

  if ("href" in rest && typeof rest.href === "string") {
    const { href, ...anchorProps } = rest as AnchorProps;
    return (
      <a
        {...anchorProps}
        href={href}
        className={classes}
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
      >
        {loading ? <span className="sk-btn__spin" aria-hidden="true" /> : null}
        {children}
      </a>
    );
  }

  const buttonProps = rest as ButtonProps;
  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      className={classes}
      disabled={buttonProps.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="sk-btn__spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
