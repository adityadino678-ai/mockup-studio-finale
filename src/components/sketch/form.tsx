import * as React from "react";
import { cn } from "@/lib/utils";

type FieldExtras = {
  label: string;
  hint?: string;
  error?: string;
};

function describedBy(...ids: Array<string | undefined | false>) {
  const value = ids.filter(Boolean).join(" ");
  return value.length ? value : undefined;
}

export function SketchInput({
  label,
  hint,
  error,
  id,
  className,
  ...props
}: React.ComponentProps<"input"> & FieldExtras) {
  const auto = React.useId();
  const inputId = id ?? `sk-input-${auto}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <span className="sk-field">
      <label className="sk-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        className={cn("sk-input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(
          error ? errorId : hint ? hintId : undefined,
          props["aria-describedby"],
        )}
      />
      {error ? (
        <span className="sk-error" id={errorId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="sk-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </span>
  );
}

export function SketchTextarea({
  label,
  hint,
  error,
  id,
  className,
  ...props
}: React.ComponentProps<"textarea"> & FieldExtras) {
  const auto = React.useId();
  const inputId = id ?? `sk-text-${auto}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <span className="sk-field">
      <label className="sk-label" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        {...props}
        id={inputId}
        className={cn("sk-textarea", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error ? errorId : hint ? hintId : undefined)}
      />
      {error ? (
        <span className="sk-error" id={errorId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="sk-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </span>
  );
}

export function SketchSelect({
  label,
  hint,
  error,
  id,
  className,
  children,
  ...props
}: React.ComponentProps<"select"> & FieldExtras) {
  const auto = React.useId();
  const inputId = id ?? `sk-select-${auto}`;

  return (
    <span className="sk-field">
      <label className="sk-label" htmlFor={inputId}>
        {label}
      </label>
      <select
        {...props}
        id={inputId}
        className={cn("sk-select", className)}
        aria-invalid={error ? true : undefined}
      >
        {children}
      </select>
      {error ? (
        <span className="sk-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="sk-hint">{hint}</span>
      ) : null}
    </span>
  );
}

export function SketchRange({
  label,
  id,
  display,
  className,
  ...props
}: React.ComponentProps<"input"> & { label: string; display?: React.ReactNode }) {
  const auto = React.useId();
  const inputId = id ?? `sk-range-${auto}`;

  return (
    <span className="sk-field">
      <label className="sk-label" htmlFor={inputId}>
        {label}
        {display !== undefined ? <output className="sk-output" htmlFor={inputId}>{display}</output> : null}
      </label>
      <input {...props} id={inputId} type="range" className={cn("sk-range", className)} />
    </span>
  );
}

export function SketchCheckbox({
  label,
  className,
  ...props
}: React.ComponentProps<"input"> & { label: React.ReactNode }) {
  return (
    <label className={cn("sk-checkbox", className)}>
      <input {...props} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

/** The sign-up / log-in segmented control from the approved auth dialog. */
export function SketchSeg<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="sk-seg" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
