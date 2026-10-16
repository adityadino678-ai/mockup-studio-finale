"use client";

import { Link } from "@/lib/client/nav";
import * as React from "react";
import { usePathname } from "@/lib/client/nav";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import {
  activeModel,
  activeProvider,
  activeProviderConfig,
  authedFetch,
  loadCachedModels,
  loadIntegrations,
  saveIntegrations,
  selectModel,
  type IntegrationConfig,
} from "@/lib/client/integrations";
import { type ModelInfo } from "@/lib/ai/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileArchive,
  Images,
  Layers,
  Loader2,
  PenTool,
  Send,
  Shapes,
  Sparkles,
  Store,
  Wand2,
  X,
} from "lucide-react";

interface QuickAction {
  label: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  onClick?: () => void;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Contextual assistant. Quick actions are REAL navigation/events in the app â€”
 * the panel never claims to perform work it cannot do. Free-text questions go
 * to the server-side AI provider and require explicit configuration.
 */
export function AssistantPanel() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [aiError, setAiError] = React.useState<string | null>(null);

  const designs = useLiveQuery(() => db.designs.count(), [], 0);
  const mockups = useLiveQuery(() => db.mockups.count(), [], 0);
  const pending = useLiveQuery(
    () => db.batchItems.where("status").anyOf("pending", "processing").count(),
    [],
    0,
  );
  const [integrations, setIntegrations] = React.useState<Record<string, boolean>>({});
  const [aiConfig, setAiConfig] = React.useState<IntegrationConfig | null>(null);
  const [models, setModels] = React.useState<ModelInfo[]>([]);

  React.useEffect(() => {
    authedFetch("/api/integrations/status")
      .then((r) => r.json())
      .then((s) =>
        setIntegrations({
          ai: !!s.ai?.configured,
          printify: !!s.printify?.configured,
          etsy: !!s.etsy?.configured,
        }),
      )
      .catch(() => setIntegrations({}));
    void loadIntegrations().then((c) => {
      setAiConfig(c);
      void loadCachedModels(c.activeProvider).then((cache) => setModels(cache?.models ?? []));
    });
  }, []);

  const switchModel = React.useCallback(
    async (modelId: string) => {
      if (!aiConfig) return;
      const next = selectModel(aiConfig, modelId);
      setAiConfig(next);
      await saveIntegrations(next);
    },
    [aiConfig],
  );

  const actions: QuickAction[] = [
    {
      label: "Upload designs",
      description: designs === 0 ? "Start by adding artwork" : `${designs} designs in your library`,
      icon: <Images className="h-3.5 w-3.5" />,
      href: "/designs",
    },
    {
      label: "Upload mockups",
      description: mockups === 0 ? "Add product photos" : `${mockups} mockups available`,
      icon: <Shapes className="h-3.5 w-3.5" />,
      href: "/mockups",
    },
    {
      label: "Open the editor",
      description: "Place artwork on a mockup",
      icon: <PenTool className="h-3.5 w-3.5" />,
      href: "/editor",
    },
    {
      label: "Start a batch job",
      description: pending > 0 ? `${pending} items pending` : "Designs Ã— mockups in one run",
      icon: <Layers className="h-3.5 w-3.5" />,
      href: "/batch",
    },
    {
      label: "Remove backgrounds",
      description: "Flood-key or local AI engine",
      icon: <Wand2 className="h-3.5 w-3.5" />,
      href: "/designs",
    },
    {
      label: "Prepare products",
      description: integrations.printify ? "Printify connected" : "Works without credentials",
      icon: <Store className="h-3.5 w-3.5" />,
      href: "/products",
    },
    {
      label: "Export a ZIP",
      description: "Organized archive + manifest",
      icon: <FileArchive className="h-3.5 w-3.5" />,
      href: "/export",
    },
  ];

  const ask = async () => {
    const text = question.trim();
    if (!text) return;
    setTurns((t) => [...t, { role: "user", text }]);
    setQuestion("");
    setLoading(true);
    setAiError(null);
    try {
      const res = await authedFetch("/api/ai/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          page: pathname,
          context: {
            designs,
            mockups,
            pendingRenders: pending,
            ...integrations,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error ?? "Assistant unavailable");
        setTurns((t) => [
          ...t,
          {
            role: "assistant",
            text: data.error ?? "The assistant is unavailable right now. The quick actions above still work.",
          },
        ]);
        return;
      }
      setTurns((t) => [...t, { role: "assistant", text: data.answer }]);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-forest text-white shadow-pop transition-transform hover:scale-105"
        title="Assistant"
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-40 flex max-h-[70vh] w-[340px] flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <div>
              <div className="text-[14px] font-semibold text-ink">Assistant</div>
              <div className="text-[11px] text-ink-subtle">
                {integrations.ai ? "AI provider connected" : "Quick actions only â€” no AI provider"}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} title="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {aiConfig && (
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
              <span className="shrink-0 text-[11px] text-ink-subtle">
                {activeProvider(aiConfig)?.label ?? "AI"}
              </span>
              {models.length > 0 ? (
                <select
                  aria-label="Model"
                  value={activeModel(aiConfig) || models[0]?.id || ""}
                  onChange={(e) => void switchModel(e.target.value)}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-1.5 text-[11px] text-ink focus-visible:border-forest focus-visible:outline-none"
                >
                  {activeModel(aiConfig) && !models.some((m) => m.id === activeModel(aiConfig)) && (
                    <option value={activeModel(aiConfig)}>{activeModel(aiConfig)}</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.free ? `${m.name} [free]` : m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Link
                  href="/settings"
                  onClick={() => setOpen(false)}
                  className="min-w-0 flex-1 truncate text-[11px] text-forest underline"
                >
                  {activeProviderConfig(aiConfig).apiKey.trim() ? "Load models in Settings →" : "Add a key in Settings →"}
                </Link>
              )}
            </div>
          )}

          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
                Jump to a workflow
              </div>
              {actions.map((a) => (
                <Link
                  key={a.label}
                  href={a.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-md p-2 transition-colors hover:bg-surface-muted"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sage-soft text-forest">
                    {a.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink">{a.label}</div>
                    <div className="truncate text-[11px] text-ink-subtle">{a.description}</div>
                  </div>
                </Link>
              ))}
            </div>

            {turns.length > 0 && (
              <div className="space-y-2 border-t border-border-subtle pt-3">
                {turns.map((turn, i) => (
                  <div
                    key={i}
                    className={`rounded-md px-3 py-2 text-[12px] leading-relaxed ${
                      turn.role === "user" ? "ml-6 bg-forest-soft text-ink" : "mr-3 bg-surface-muted text-ink-muted"
                    }`}
                  >
                    {turn.text}
                  </div>
                ))}
              </div>
            )}

            {aiError && !integrations.ai && (
              <p className="rounded-md bg-surface-muted px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
                Free-text questions need an AI provider. Paste an API key under{" "}
                <Link href="/settings" onClick={() => setOpen(false)} className="text-forest underline">
                  Settings → API connections
                </Link>
                . Quick actions above work regardless.
              </p>
            )}
          </div>

          <div className="border-t border-border-subtle p-2.5">
            <div className="flex gap-1.5">
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
                placeholder={integrations.ai ? "Ask how to do somethingâ€¦" : "Needs AI providerâ€¦"}
                disabled={!integrations.ai || loading}
                className="h-8 text-[12px]"
              />
              <Button size="icon-sm" onClick={ask} disabled={!integrations.ai || loading}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}