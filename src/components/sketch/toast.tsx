import * as React from "react";

export type SketchToastKind = "info" | "success" | "error";

interface ToastItem {
  id: number;
  kind: SketchToastKind;
  message: string;
}

interface ToastContextValue {
  push: (message: string, kind?: SketchToastKind) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);
let nextId = 1;

/**
 * Small, dependency-free toast stack. Every async action in the sketch UI uses
 * this for its success and error states.
 */
export function SketchToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef<number[]>([]);

  const dismiss = React.useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = React.useCallback(
    (message: string, kind: SketchToastKind = "info") => {
      const id = nextId++;
      setItems((current) => [...current.slice(-2), { id, kind, message }]);
      const timer = window.setTimeout(() => dismiss(id), 5000);
      timers.current.push(timer);
    },
    [dismiss],
  );

  React.useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const value = React.useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sk-toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`sk-toast sk-toast--${item.kind}`}>
            <span>{item.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useSketchToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useSketchToast must be used inside <SketchToastProvider>");
  }
  return context;
}
