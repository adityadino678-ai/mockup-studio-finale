"use client";

import * as React from "react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { logActivity } from "@/lib/db/repo";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Separator, Badge } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { cn, formatBytes } from "@/lib/utils";
import {
  EMPTY_INTEGRATIONS,
  authedFetch,
  clearIntegrations,
  integrationHeaders,
  loadIntegrations,
  saveIntegrations,
  type IntegrationConfig,
} from "@/lib/client/integrations";
import {
  Check,
  CircleCheck,
  CircleX,
  Cloud,
  Database,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from "lucide-react";

interface IntegrationStatus {
  configured: boolean;
  source?: "browser" | "server" | null;
  providerLabel?: string;
  detail?: string;
  checkedAt: number;
}

interface TestResult {
  ok: boolean;
  message: string;
  at: number;
}

type Provider = "printify" | "ai";

export function SettingsPage() {
  const [storage, setStorage] = React.useState<{ usage: number; quota: number } | null>(null);
  const [integrations, setIntegrations] = React.useState<Record<string, IntegrationStatus> | null>(null);
  const [integrationsError, setIntegrationsError] = React.useState<string | null>(null);
  const [config, setConfig] = React.useState<IntegrationConfig | null>(null);
  const [reveal, setReveal] = React.useState<Record<string, boolean>>({});
  const [testing, setTesting] = React.useState<Provider | null>(null);
  const [results, setResults] = React.useState<Partial<Record<Provider, TestResult>>>({});

  const counts = useLiveQuery(async () => {
    const [designs, mockups, assets, renders, templates] = await Promise.all([
      db.designs.count(),
      db.mockups.count(),
      db.assets.count(),
      db.assets.where("kind").equals("mockup-render").count(),
      db.templates.count(),
    ]);
    return { designs, mockups, assets, renders, templates };
  }, []);

  const refreshStatus = React.useCallback(async () => {
    try {
      const res = await authedFetch("/api/integrations/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setIntegrations(await res.json());
      setIntegrationsError(null);
    } catch (e) {
      setIntegrationsError(e instanceof Error ? e.message : "Failed to load integration status");
    }
  }, []);

  React.useEffect(() => {
    navigator.storage?.estimate?.().then((est) => {
      if (est.usage != null && est.quota != null) {
        setStorage({ usage: est.usage, quota: est.quota });
      }
    });
    void refreshStatus();
    void loadIntegrations().then(setConfig);
  }, [refreshStatus]);

  const patchConfig = (patch: Partial<IntegrationConfig>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
  };

  const onSave = async () => {
    if (!config) return;
    await saveIntegrations(config);
    await logActivity("integration.save", "Saved integration API keys to this browser");
    toast.success("Keys saved in this browser");
    void refreshStatus();
  };

  const onClear = async () => {
    await clearIntegrations();
    setConfig({ ...EMPTY_INTEGRATIONS });
    setResults({});
    await logActivity("integration.save", "Cleared integration API keys from this browser");
    toast.success("Keys cleared from this browser");
    void refreshStatus();
  };

  const runTest = async (provider: Provider) => {
    if (!config) return;
    setTesting(provider);
    try {
      const res = await fetch("/api/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...integrationHeaders(config) },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      const result: TestResult = {
        ok: !!data.ok,
        message: data.message ?? data.error ?? `HTTP ${res.status}`,
        at: Date.now(),
      };
      setResults((r) => ({ ...r, [provider]: result }));
      await logActivity(
        "integration.test",
        `${provider === "printify" ? "Printify" : "AI"} connection test ${result.ok ? "succeeded" : "failed"}: ${result.message}`,
      );
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      void refreshStatus();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Request failed";
      setResults((r) => ({ ...r, [provider]: { ok: false, message, at: Date.now() } }));
      toast.error(message);
    } finally {
      setTesting(null);
    }
  };

  const printifyStatus = integrations?.printify;
  const aiStatus = integrations?.ai;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <PageHeader title="Settings" description="Workspace storage and external integrations." />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-forest" /> Local storage
          </CardTitle>
          <CardDescription>
            Mockup Studio stores all designs, mockups and generated images in your browser&rsquo;s
            IndexedDB. Nothing is uploaded anywhere.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!counts ? (
            <div className="h-16 animate-pulse rounded-md bg-surface-muted" />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Designs" value={counts.designs} />
              <Stat label="Mockups" value={counts.mockups} />
              <Stat label="Assets" value={counts.assets} />
              <Stat label="Renders" value={counts.renders} />
              <Stat label="Templates" value={counts.templates} />
            </div>
          )}
          <Separator className="my-4" />
          {storage ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[13px]">
                <span className="text-ink-muted">Browser storage used</span>
                <span className="text-ink">
                  {formatBytes(storage.usage)} {storage.quota ? `of ~${formatBytes(storage.quota)}` : ""}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-forest transition-all"
                  style={{ width: `${storage.quota ? Math.min(100, (storage.usage / storage.quota) * 100) : 100}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-ink-muted">Storage estimate unavailable in this browser.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-forest" /> API connections
          </CardTitle>
          <CardDescription>
            Paste your own keys to connect Printify and any OpenAI-compatible AI model. Keys are stored
            only in this browser (IndexedDB), sent to the provider through the server on each request,
            and never written to the server. Clear them any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {integrationsError && (
            <EmptyState
              icon={<SettingsIcon />}
              title="Could not check integrations"
              description={`The status endpoint failed: ${integrationsError}`}
            />
          )}

          {config ? (
            <>
              {/* Printify */}
              <section className="space-y-2 rounded-md border border-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Cloud className="h-4 w-4 text-ink-subtle" /> Printify
                  </div>
                  <StatusBadge status={printifyStatus} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="printify-key">Printify API key</Label>
                  <SecretInput
                    id="printify-key"
                    value={config.printifyKey}
                    reveal={!!reveal.printifyKey}
                    onToggleReveal={() => setReveal((r) => ({ ...r, printifyKey: !r.printifyKey }))}
                    onChange={(v) => patchConfig({ printifyKey: v })}
                    placeholder="Paste your Printify personal access token"
                  />
                  <p className="text-[11px] text-ink-subtle">
                    Create one at{" "}
                    <a
                      href="https://developers.printify.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-forest underline"
                    >
                      developers.printify.com
                    </a>
                    . Used to read the live catalog and to create products you explicitly confirm.
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runTest("printify")}
                    disabled={testing !== null || !config.printifyKey.trim()}
                  >
                    {testing === "printify" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Test connection
                  </Button>
                </div>
                <ResultLine result={results.printify} testing={testing === "printify"} />
              </section>

              <Separator />

              {/* AI */}
              <section className="space-y-2 rounded-md border border-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Sparkles className="h-4 w-4 text-ink-subtle" /> AI model
                  </div>
                  <StatusBadge status={aiStatus} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-key">AI API key</Label>
                  <SecretInput
                    id="ai-key"
                    value={config.aiKey}
                    reveal={!!reveal.aiKey}
                    onToggleReveal={() => setReveal((r) => ({ ...r, aiKey: !r.aiKey }))}
                    onChange={(v) => patchConfig({ aiKey: v })}
                    placeholder="Paste any OpenAI-compatible API key"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ai-base-url">Base URL</Label>
                    <Input
                      id="ai-base-url"
                      value={config.aiBaseUrl}
                      onChange={(e) => patchConfig({ aiBaseUrl: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                      className="font-mono text-[12px]"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ai-model">Model</Label>
                    <Input
                      id="ai-model"
                      value={config.aiModel}
                      onChange={(e) => patchConfig({ aiModel: e.target.value })}
                      placeholder="gpt-4o-mini"
                      className="font-mono text-[12px]"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <p className="text-[11px] text-ink-subtle">
                  Works with OpenAI, OpenRouter, Groq, DeepSeek, Together, a local server, or any other
                  OpenAI-compatible endpoint. Leave base URL/model empty to use the defaults.
                </p>
                <div className="flex items-center gap-2 pt-0.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runTest("ai")}
                    disabled={testing !== null || !config.aiKey.trim()}
                  >
                    {testing === "ai" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Test connection
                  </Button>
                </div>
                <ResultLine result={results.ai} testing={testing === "ai"} />
              </section>

              <Separator />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
                  <Server className="h-3.5 w-3.5" /> A server-set key still works as a fallback when no
                  key is saved here.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={onClear}>
                    <Trash2 className="h-3.5 w-3.5" /> Clear
                  </Button>
                  <Button size="sm" onClick={onSave}>
                    <Check className="h-3.5 w-3.5" /> Save keys
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="h-24 animate-pulse rounded-md bg-surface-muted" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status?: IntegrationStatus }) {
  if (!status) {
    return (
      <Badge variant="muted" className="shrink-0">
        <Database className="h-3 w-3" /> checking…
      </Badge>
    );
  }
  if (!status.configured) {
    return (
      <Badge variant="outline" className="shrink-0">
        not configured
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="shrink-0">
      <CircleCheck className="h-3 w-3" />
      {status.source === "browser" ? "browser key" : "server key"}
    </Badge>
  );
}

function ResultLine({ result, testing }: { result?: TestResult; testing: boolean }) {
  if (testing) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing connection…
      </p>
    );
  }
  if (!result) return null;
  return (
    <p className={cn("flex items-start gap-1.5 text-[12px]", result.ok ? "text-forest" : "text-danger")}>
      {result.ok ? (
        <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="leading-relaxed">{result.message}</span>
    </p>
  );
}

function SecretInput({
  id,
  value,
  placeholder,
  reveal,
  onChange,
  onToggleReveal,
}: {
  id: string;
  value: string;
  placeholder: string;
  reveal: boolean;
  onChange: (value: string) => void;
  onToggleReveal: () => void;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10 font-mono text-[12px]"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={onToggleReveal}
        title={reveal ? "Hide" : "Show"}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink-subtle transition-colors hover:text-ink"
      >
        {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-muted px-3 py-2">
      <div className="text-lg font-semibold leading-none text-ink">{value}</div>
      <div className="mt-1 text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}
