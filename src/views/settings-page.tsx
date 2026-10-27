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
  activeModel,
  activeProvider,
  activeProviderConfig,
  authedFetch,
  clearIntegrations,
  integrationHeaders,
  loadCachedModels,
  loadIntegrations,
  patchProvider,
  saveCachedModels,
  saveIntegrations,
  selectModel,
  selectProvider,
  type IntegrationConfig,
} from "@/lib/client/integrations";
import { providerList, type ModelInfo } from "@/lib/ai/providers";
import {
  Check,
  CircleCheck,
  CircleX,
  Cloud,
  Database,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  User,
  UserPlus,
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

/** One row of GET /api/printify/shops. */
interface ShopOption {
  id: number;
  title: string;
  salesChannel: string;
  connected: boolean;
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
  const [models, setModels] = React.useState<ModelInfo[] | null>(null);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [modelQuery, setModelQuery] = React.useState("");
  const [shops, setShops] = React.useState<ShopOption[] | null>(null);
  const [shopsLoading, setShopsLoading] = React.useState(false);
  const [shopsError, setShopsError] = React.useState<string | null>(null);
  const [shopNotice, setShopNotice] = React.useState<string | null>(null);
  const [etsyQuery, setEtsyQuery] = React.useState("personalized t-shirt");
  const [etsyTesting, setEtsyTesting] = React.useState(false);
  const [etsyResult, setEtsyResult] = React.useState<TestResult | null>(null);

  // ---- Supabase auth (email/password only) ----
const [authUser, setAuthUser] = React.useState<{ id: string; email: string } | null>(null);
const [authLoading, setAuthLoading] = React.useState(false);
const [authError, setAuthError] = React.useState<string | null>(null);
const [authMode, setAuthMode] = React.useState<"signin" | "signup">("signin");
const [supabaseConfigured, setSupabaseConfigured] = React.useState<boolean | null>(null);

const checkSupabase = async () => {
  try {
    const res = await fetch("/api/auth/me");
    setSupabaseConfigured(res.ok);
    if (res.ok) {
      const data = await res.json();
      setAuthUser(data.user);
    }
  } catch {
    setSupabaseConfigured(false);
  }
};

const handleSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  const formData = new FormData(e.currentTarget);
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  setAuthLoading(true);
  setAuthError(null);
  try {
    const { signIn } = await import("@/lib/auth/session");
    await signIn(email, password);
    setAuthLoading(false);
    await checkSupabase();
    toast.success("Signed in");
  } catch (e) {
    setAuthLoading(false);
    setAuthError(e instanceof Error ? e.message : "Sign in failed");
    toast.error(e instanceof Error ? e.message : "Sign in failed");
  }
};

const handleSignUp = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  const formData = new FormData(e.currentTarget);
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const fullName = formData.get("full_name") as string;
  setAuthLoading(true);
  setAuthError(null);
  try {
    const { signUp } = await import("@/lib/auth/session");
    await signUp(email, password, fullName);
    setAuthLoading(false);
    toast.success("Account created — please sign in");
    setAuthMode("signin");
  } catch (e) {
    setAuthLoading(false);
    setAuthError(e instanceof Error ? e.message : "Sign up failed");
    toast.error(e instanceof Error ? e.message : "Sign up failed");
  }
};

const handleSignOut = async () => {
  const { signOut } = await import("@/lib/auth/session");
  await signOut();
  setAuthUser(null);
  setSupabaseConfigured(false);
  toast.success("Signed out");
};

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
    void checkSupabase();
    void loadIntegrations().then((c) => {
      setConfig(c);
      // Show any previously fetched model list immediately.
      void loadCachedModels(c.activeProvider).then((cache) => {
        if (cache) setModels(cache.models);
      });
    });
  }, [refreshStatus]);

  const patchConfig = (patch: Partial<IntegrationConfig>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
  };

  /**
   * Loads the shop list with the key CURRENTLY in the form.
   *
   * It deliberately uses `fetch` + `integrationHeaders(config)` rather than
   * `authedFetch`: authedFetch reads the SAVED config, so a key the user just
   * typed would be ignored and an old key would be sent instead.
   */
  const refreshShops = async (next: IntegrationConfig, opts: { silent?: boolean } = {}) => {
    if (!next.printifyKey.trim()) {
      setShops(null);
      setShopsError(null);
      setShopNotice(null);
      return;
    }
    setShopsLoading(true);
    setShopsError(null);
    if (!opts.silent) setShopNotice(null);
    try {
      const response = await fetch("/api/printify/shops", {
        headers: integrationHeaders(next),
      });
      const data = (await response.json().catch(() => null)) as
        | { shops?: ShopOption[]; error?: string }
        | null;
      if (!response.ok) {
        setShops([]);
        setShopsError(data?.error ?? `Could not load Printify shops (HTTP ${response.status}).`);
        return;
      }
      const list = Array.isArray(data?.shops) ? data.shops : [];
      setShops(list);
      const saved = next.printifyShopId;
      if (saved != null && !list.some((shop) => shop.id === saved)) {
        // A shop that disappeared must not stay selected: the next product
        // would be created in a fallback shop the user never chose.
        patchConfig({ printifyShopId: undefined });
        setShopNotice(
          `Shop #${saved} is not in this account's shop list any more. The form selection was cleared — choose a shop and press Save. Other pages keep the old value until you do.`,
        );
      }
    } catch (e) {
      setShops([]);
      setShopsError(e instanceof Error ? e.message : "Could not load the Printify shop list");
    } finally {
      setShopsLoading(false);
    }
  };

  // Load the list once the key settles. Typing a key re-arms a short timer, so
  // a partially typed token never spends a request; "Refresh shops" is the
  // explicit way to reload after anything else changes.
  React.useEffect(() => {
    if (!config) return;
    const key = config.printifyKey.trim();
    setShops(null);
    setShopsError(null);
    setShopNotice(null);
    if (!key) return;
    const timer = window.setTimeout(() => {
      void refreshShops({ ...config, printifyKey: key }, { silent: true });
    }, 600);
    return () => window.clearTimeout(timer);
    // Only the key's value triggers a load; selecting a shop must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.printifyKey]);

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
    setModels(null);
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

  /**
   * Etsy has no "connection" to test: the keystring either lets the public
   * listing search answer or it does not. A real query is the honest probe,
   * and it also shows the user what the autopilot will receive.
   */
  const runEtsyTest = async () => {
    if (!config) return;
    const query = etsyQuery.trim();
    if (query.length < 2) {
      toast.error("Enter a search query first");
      return;
    }
    setEtsyTesting(true);
    try {
      const res = await fetch("/api/etsy/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...integrationHeaders(config) },
        body: JSON.stringify({ query }),
      });
      const data = await res.json().catch(() => null);
      const research = data?.research;
      const ok = res.ok && !!research;
      const result: TestResult = {
        ok,
        message: ok
          ? `${Number(research.activeListings ?? 0).toLocaleString()} active listing(s) · ${Number(
              research.sampled ?? 0,
            )} sampled · ${(research.topTags ?? []).length} recurring tag(s)`
          : (data?.error ?? `HTTP ${res.status}`),
        at: Date.now(),
      };
      setEtsyResult(result);
      if (ok) toast.success("Etsy research is working");
      else toast.error(result.message);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Etsy research failed";
      setEtsyResult({ ok: false, message, at: Date.now() });
      toast.error(message);
    } finally {
      setEtsyTesting(false);
    }
  };

  const onProviderChange = (id: string) => {
    if (!config) return;
    setConfig(selectProvider(config, id));
    setModels(null);
    setModelQuery("");
    void loadCachedModels(id).then((cache) => {
      if (cache) setModels(cache.models);
    });
  };

  const loadModels = async () => {
    if (!config) return;
    const providerId = config.activeProvider;
    setLoadingModels(true);
    try {
      const res = await fetch("/api/integrations/models", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...integrationHeaders(config) },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast.error(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      const list = (data.models ?? []) as ModelInfo[];
      setModels(list);
      await saveCachedModels(providerId, list);
      toast.success(
        `Loaded ${list.length} model${list.length === 1 ? "" : "s"}${
          data.free ? ` · ${data.free} free` : ""
        }`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not fetch models");
    } finally {
      setLoadingModels(false);
    }
  };

  const onSelectModel = (modelId: string) => {
    if (!config) return;
    setConfig(selectModel(config, modelId));
  };

  const printifyStatus = integrations?.printify;
  const aiStatus = integrations?.ai;
  const selectedShop = (shops ?? []).find((shop) => shop.id === config?.printifyShopId);
  const def = config ? activeProvider(config) : undefined;
  const providerConf = config ? activeProviderConfig(config) : { apiKey: "" };
  const currentModel = config ? activeModel(config) : "";
  const needsKey = def ? !def.keyOptional : true;
  const canLoad = !!config && (!needsKey || providerConf.apiKey.trim().length > 0);

  const filteredModels = React.useMemo(() => {
    if (!models) return [];
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, modelQuery]);

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

      {/* Supabase auth card */}
      {supabaseConfigured !== null && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {authUser ? (
                <LogOut className="h-4 w-4 text-forest" />
              ) : (
                <LogIn className="h-4 w-4 text-forest" />
              )}
              Account
            </CardTitle>
            <CardDescription>
              Sign in with email to sync your designs, mockups and listings to Supabase.
              Optional — the app works fully without an account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!supabaseConfigured && (
              <div className="rounded-md border border-border-subtle bg-surface-muted p-3 text-[13px] text-ink-muted">
                Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_ANON_KEY to server
                secrets to enable account sync.
              </div>
            )}
            {supabaseConfigured && !authUser && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <button
                    onClick={() => setAuthMode("signin")}
                    className={`px-4 py-2 rounded-md border border-border-strong transition-colors ${
                      authMode === "signin" ? "bg-surface-muted text-ink" : "text-ink-muted hover:bg-surface-muted"
                    }`}
                  >
                    Sign in
                  </button>
                  <button
                    onClick={() => setAuthMode("signup")}
                    className={`px-4 py-2 rounded-md border border-border-strong transition-colors ${
                      authMode === "signup" ? "bg-surface-muted text-ink" : "text-ink-muted hover:bg-surface-muted"
                    }`}
                  >
                    Create account
                  </button>
                </div>
                <form onSubmit={authMode === "signin" ? handleSignIn : handleSignUp} className="space-y-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="auth-email">Email</Label>
                    <Input
                      id="auth-email"
                      type="email"
                      required
                      className="flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-ink shadow-subtle transition-colors focus-visible:border-forest focus-visible:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="auth-password">Password</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      required
                      minLength={8}
                      className="flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-ink shadow-subtle transition-colors focus-visible:border-forest focus-visible:outline-none"
                    />
                  </div>
                  {authMode === "signup" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="auth-full-name">Full name (optional)</Label>
                      <Input
                        id="auth-full-name"
                        type="text"
                        className="flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-ink shadow-subtle transition-colors focus-visible:border-forest focus-visible:outline-none"
                      />
                    </div>
                  )}
                  {authError && (
                    <p className="text-[12px] text-danger">{authError}</p>
                  )}
                  <Button type="submit" disabled={authLoading} className="w-full">
                    {authLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      authMode === "signin" ? <LogIn className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />
                    )}
                    {authLoading ? "Signing in…" : authMode === "signin" ? "Sign in" : "Create account"}
                  </Button>
                </form>
              </>
            )}
            {supabaseConfigured && authUser && (
              <div className="flex items-center justify-between space-y-2 sm:space-y-0 sm:flex-row">
                <div className="flex items-center gap-3">
                  <User className="h-4 w-4 text-forest" />
                  <div>
                    <div className="text-sm font-medium text-ink">{authUser.email}</div>
                    <div className="text-[12px] text-ink-muted">Signed in to Supabase</div>
                  </div>
                </div>
                <Button variant="outline" onClick={handleSignOut} disabled={authLoading} size="sm">
                  {authLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
                  Sign out
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-forest" /> API connections
          </CardTitle>
          <CardDescription>
            Paste your own keys to connect Printify, Etsy research and any AI provider. Keys are
            stored only in this browser (IndexedDB), sent to the provider through the server on each
            request, and never written to the server. Clear them any time.
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

                <div className="space-y-1.5">
                  <Label htmlFor="printify-shop">Printify shop</Label>
                  <div className="flex items-start gap-2">
                    <select
                      id="printify-shop"
                      value={config.printifyShopId != null ? String(config.printifyShopId) : ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setShopNotice(null);
                        patchConfig({
                          printifyShopId: value ? Number(value) : undefined,
                        });
                      }}
                      disabled={!config.printifyKey.trim() || shopsLoading || !shops?.length}
                      className="flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-ink shadow-subtle transition-colors focus-visible:border-forest focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">
                        {!config.printifyKey.trim()
                          ? "Paste a Printify key first"
                          : shopsLoading
                            ? "Loading shops…"
                            : shopsError
                              ? "Shops unavailable — refresh"
                              : shops?.length
                                ? "Choose a shop…"
                                : "No shops on this account"}
                      </option>
                      {(shops ?? []).map((shop) => (
                        <option key={shop.id} value={String(shop.id)}>
                          {`${shop.title || "Untitled shop"} (#${shop.id})`}
                          {shop.connected
                            ? shop.salesChannel
                              ? ` — ${shop.salesChannel}`
                              : " — connected"
                            : " — Not connected"}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshShops(config)}
                      disabled={!config.printifyKey.trim() || shopsLoading}
                      className="shrink-0"
                    >
                      {shopsLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Refresh shops
                    </Button>
                  </div>
                  <p className="text-[11px] text-ink-subtle">
                    Used for product creation, Send and Publish.
                    {selectedShop && !selectedShop.connected
                      ? " This shop is not connected to a sales channel (Etsy), so publishing to it will fail — connect it in Printify or pick a connected shop."
                      : ""}
                  </p>
                  {shopNotice && <p className="text-[11px] text-warning">{shopNotice}</p>}
                  {shopsError && <p className="text-[11px] text-danger">{shopsError}</p>}
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

              {/* Etsy research - read-only Open API v3. */}
              <section className="space-y-2 rounded-md border border-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Search className="h-4 w-4 text-ink-subtle" /> Etsy research
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    Read-only
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="etsy-keystring">Etsy keystring</Label>
                  <SecretInput
                    id="etsy-keystring"
                    value={config.etsyKeystring ?? ""}
                    reveal={!!reveal.etsyKeystring}
                    onToggleReveal={() =>
                      setReveal((r) => ({ ...r, etsyKeystring: !r.etsyKeystring }))
                    }
                    onChange={(v) => patchConfig({ etsyKeystring: v })}
                    placeholder="Paste your Etsy developer keystring"
                  />
                  <p id="etsy-keystring-note" className="text-[11px] text-ink-subtle">
                    From{" "}
                    <a
                      href="https://www.etsy.com/developers/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-forest underline"
                    >
                      etsy.com/developers
                    </a>
                    . Used only for the public active-listing search: the autopilot reads tags,
                    titles and prices. Nothing is written to Etsy, and this app never scrapes the
                    site.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2 pt-1">
                  <div className="min-w-[180px] flex-1 space-y-1.5">
                    <Label htmlFor="etsy-test-query" className="text-ink-muted">
                      Test with a search
                    </Label>
                    <Input
                      id="etsy-test-query"
                      value={etsyQuery}
                      onChange={(e) => setEtsyQuery(e.target.value)}
                      placeholder="personalized t-shirt"
                      className="text-[12px]"
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={runEtsyTest}
                    disabled={etsyTesting || !config.etsyKeystring?.trim()}
                  >
                    {etsyTesting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5" />
                    )}
                    Test research
                  </Button>
                </div>
                <ResultLine result={etsyResult ?? undefined} testing={etsyTesting} />
              </section>

              <Separator />

              {/* AI provider */}
              <section className="space-y-3 rounded-md border border-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Sparkles className="h-4 w-4 text-ink-subtle" /> AI model
                  </div>
                  <StatusBadge status={aiStatus} />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ai-provider">Provider</Label>
                  <select
                    id="ai-provider"
                    value={config.activeProvider}
                    onChange={(e) => onProviderChange(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-ink shadow-subtle transition-colors focus-visible:border-forest focus-visible:outline-none"
                  >
                    {providerList().map((p) => (
                      <option key={p.id} value={p.id}>
                        {config.providers[p.id]?.apiKey?.trim() ? "✓ " : ""}
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {def && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-ink-subtle">
                      <span>{def.blurb}</span>
                      {def.freeTier && (
                        <Badge variant="default" className="shrink-0">
                          {def.freeTier}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ai-key">AI API key</Label>
                  <SecretInput
                    id="ai-key"
                    value={providerConf.apiKey}
                    reveal={!!reveal.aiKey}
                    onToggleReveal={() => setReveal((r) => ({ ...r, aiKey: !r.aiKey }))}
                    onChange={(v) => patchConfig(patchProvider(config, config.activeProvider, { apiKey: v }))}
                    placeholder={def?.keyHint ?? "Paste any OpenAI-compatible API key"}
                  />
                  {def && (
                    <p className="text-[11px] text-ink-subtle">
                      {def.keyOptional ? "No key needed. " : "Get a key at "}
                      {!def.keyOptional && (
                        <a href={def.docsUrl} target="_blank" rel="noreferrer" className="text-forest underline">
                          {def.docsUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                        </a>
                      )}
                    </p>
                  )}
                </div>

                {config.activeProvider === "custom" && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ai-base-url">Base URL</Label>
                      <Input
                        id="ai-base-url"
                        value={providerConf.baseUrl ?? ""}
                        onChange={(e) =>
                          patchConfig(patchProvider(config, "custom", { baseUrl: e.target.value }))
                        }
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
                        value={providerConf.model ?? ""}
                        onChange={(e) => patchConfig(patchProvider(config, "custom", { model: e.target.value }))}
                        placeholder="gpt-4o-mini"
                        className="font-mono text-[12px]"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadModels}
                    disabled={testing !== null || loadingModels || !canLoad}
                  >
                    {loadingModels ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    Load models
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runTest("ai")}
                    disabled={testing !== null || !canLoad}
                  >
                    {testing === "ai" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Test connection
                  </Button>
                  {currentModel && (
                    <span className="text-[11px] text-ink-muted">
                      Active: <span className="font-mono text-ink">{currentModel}</span>
                    </span>
                  )}
                </div>

                {models && (
                  <div className="space-y-1.5 border-t border-border-subtle pt-3">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
                      <Input
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder={`Search ${models.length} models…`}
                        className="pl-8 text-[12px]"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="scroll-thin max-h-64 overflow-y-auto rounded-md border border-border-subtle">
                      {filteredModels.length === 0 ? (
                        <p className="p-3 text-[12px] text-ink-muted">No models match “{modelQuery}”.</p>
                      ) : (
                        filteredModels.map((m) => {
                          const active = m.id === currentModel;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => onSelectModel(m.id)}
                              className={cn(
                                "flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-muted",
                                active && "bg-sage-soft",
                              )}
                            >
                              <span className="min-w-0">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate text-[12px] font-medium text-ink">{m.name}</span>
                                  {m.free && (
                                    <Badge variant="default" className="shrink-0 px-1.5 py-0 text-[10px]">
                                      free
                                    </Badge>
                                  )}
                                </span>
                                <span className="block truncate font-mono text-[10px] text-ink-subtle">
                                  {m.id}
                                </span>
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                {m.contextLength && (
                                  <span className="text-[10px] text-ink-subtle">{formatContext(m.contextLength)}</span>
                                )}
                                {active && <Check className="h-3.5 w-3.5 text-forest" />}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                    <p className="text-[10px] text-ink-subtle">
                      Fetched live from {def?.label ?? "the provider"}. Free models are tagged from the
                      provider&rsquo;s own pricing where available.
                    </p>
                  </div>
                )}

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

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
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
