import * as React from "react";

/**
 * Native <dialog>: focus trapping, Escape and backdrop dismissal come from the
 * platform, so the modal stays keyboard accessible without a dependency.
 */
export function SketchDialog({
  open,
  onClose,
  title,
  children,
  labelledBy = "sk-dialog-title",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  labelledBy?: string;
}) {
  const ref = React.useRef<HTMLDialogElement | null>(null);

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Native showModal() focuses the first control in DOM order (our close
      // button). A form dialog is faster to use when its first field is focused.
      const firstField = dialog.querySelector<HTMLElement>(
        "input:not([type='hidden']), select, textarea",
      );
      firstField?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sk-dialog"
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <button
        type="button"
        className="sk-dialog__close"
        aria-label="Close dialog"
        onClick={onClose}
      >
        ×
      </button>
      <h3 id={labelledBy}>{title}</h3>
      {children}
    </dialog>
  );
}
