"use client";

import * as React from "react";
import { toast } from "sonner";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db/schema";
import { logActivity, uid } from "@/lib/db/repo";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/primitives";
import { cn, formatDateTime } from "@/lib/utils";
import {
  KeyRound,
  Lightbulb,
  Loader2,
  Save,
  Sparkles,
  Tags,
  TriangleAlert,
} from "lucide-react";

interface Keyword {
  term: string;
  intent: string;
  rationale?: string;
}

interface SeoResult {
  keywords: Keyword[];
  productAngles: string[];
  audienceAngles: string[];
  seasonalIdeas: string[];
  titleDrafts: string[];
  descriptionDraft: string;
  tags: string[];
  disclaimer?: string;
}

const INTENTS = ["search", "discovery", "gifting", "seasonal", "problem-solution"];

export default function SeoStudioPage() {
  const [status, setStatus] = React.useState<{ configured: boolean; detail?: string } | null>(null);
  const [niche, setNiche] = React.useState("");
  const [productType, setProductType] = React.useState("t-shirt");
  const [audience, setAudience] = React.useState("");
  const [season, setSeason] = React.useState("");
  const [seed, setSeed] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SeoResult | null>(null);
  const [researchedAt, setResearchedAt] = React.useState<string | null>(null);
  const [intentFilter, setIntentFilter] = React.useState<string>("all");

  const saved = useLiveQuery(() => db.templates.where("category").equals("seo").toArray(), []);

  React.useEffect(() => {
    fetch("/api/integrations/status")
      .then((r) => r.json())
      .then((s) => setStatus({ configured: !!s.ai?.configured, detail: s.ai?.detail }))
      .catch(() => setStatus({ configured: false, detail: "Could not reach the server" }));
  }, []);

  const run = async () => {
    if (!niche.trim()) {
      setError("Enter a niche or design concept first");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ niche, productType, audience, season, seedKeyword: seed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Request failed (HTTP ${res.status})`);
        return;
      }
      setResult(data.result);
      setResearchedAt(data.researchedAt);
      toast.success(`Research complete using ${data.model}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const saveAsTemplate = async () => {
    if (!result) return;
    await db.templates.put({
      id: uid(),
      name: `SEO — ${niche}`,
      category: "seo",
      description: `Keywords, titles and tags for "${niche}"`,
      version: 1,
      payload: {
        type: "seo",
        niche,
        audience,
        season,
        keywords: result.keywords.map((k) => k.term),
        titleDrafts: result.titleDrafts,
        descriptionDraft: result.descriptionDraft,
        tags: result.tags,
        savedAt: Date.now(),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await logActivity("template.apply", `Saved SEO research "${niche}" as a template`);
    toast.success("Saved to Templates");
  };

  const createListingDraft = async () => {
    if (!result) return;
    const now = Date.now();
    await db.listingDrafts.put({
      id: uid(),
      title: result.titleDrafts[0] ?? `${niche} ${productType}`,
      description: result.descriptionDraft,
      tags: result.tags,
      priceCents: 2499,
      quantity: 1,
      imageAssetIds: [],
      status: "local-draft",
      createdAt: now,
      updatedAt: now,
    });
    toast.success("Listing draft created — edit it in Listings");
  };

  const filteredKeywords = result?.keywords.filter((k) => intentFilter === "all" || k.intent === intentFilter) ?? [];

  return (
    <div className="mx-auto max-w-5xl p-8">
      <PageHeader
        title="AI SEO Studio"
        description="Research keywords and draft listing copy. Everything is editable and none of it is verified market data."
      />

      {/* Provider status */}
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sage-soft text-forest">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <div className="text-[14px] font-medium text-ink">AI provider</div>
              <div className="max-w-xl text-[12px] text-ink-muted">
                {!status ? "Checking…" : status.detail}
              </div>
            </div>
          </div>
          <Badge variant={status?.configured ? "forest" : "outline"}>
            {status?.configured ? "configured" : "not configured"}
          </Badge>
        </CardContent>
        {status && !status.configured && (
          <>
            <Separator />
            <CardContent className="space-y-1.5 pt-4">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <KeyRound className="h-3.5 w-3.5" /> Enable AI features
              </p>
              <ol className="list-inside list-decimal space-y-1 text-[12px] leading-relaxed text-ink-muted">
                <li>
                  Add <code className="rounded bg-surface-muted px-1">AI_API_KEY=…</code> to{" "}
                  <code className="rounded bg-surface-muted px-1">.env.local</code>.
                </li>
                <li>
                  Optionally set <code className="rounded bg-surface-muted px-1">AI_BASE_URL</code> for any
                  OpenAI-compatible provider and <code className="rounded bg-surface-muted px-1">AI_MODEL</code>.
                </li>
                <li>Restart the dev server. All other features keep working without it.</li>
              </ol>
            </CardContent>
          </>
        )}
      </Card>

      {/* Inputs */}
      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="text-[14px]">What are you selling?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Niche or design concept *</Label>
              <Input value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. retro hiking, cat dad, plant mom" />
            </div>
            <div className="space-y-1.5">
              <Label>Product type</Label>
              <Select value={productType} onValueChange={setProductType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["t-shirt", "hoodie", "mug", "tote bag", "sticker", "poster", "sweatshirt", "phone case"].map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Target audience</Label>
              <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. new moms, hikers, gift shoppers" />
            </div>
            <div className="space-y-1.5">
              <Label>Season / timing</Label>
              <Input value={season} onChange={(e) => setSeason(e.target.value)} placeholder="e.g. christmas, graduation, year-round" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Seed keyword (optional)</Label>
            <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="e.g. funny hiking shirt" />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 rounded-md bg-surface-muted px-3 py-2 text-[12px] text-ink-muted">
              <TriangleAlert className="h-3.5 w-3.5 text-warning" /> {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={run} disabled={loading || !status?.configured}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {loading ? "Researching…" : "Research & draft"}
            </Button>
            {!status?.configured && <span className="text-[12px] text-ink-subtle">Configure an AI provider to enable</span>}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {result ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-ink-subtle">
              AI-generated ideas{researchedAt ? ` · generated ${formatDateTime(new Date(researchedAt).getTime())}` : ""}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={saveAsTemplate}>
                <Save className="h-3.5 w-3.5" /> Save as template
              </Button>
              <Button size="sm" onClick={createListingDraft}>
                <Tags className="h-3.5 w-3.5" /> Create listing draft
              </Button>
            </div>
          </div>

          {result.disclaimer && (
            <p className="flex items-center gap-1.5 rounded-md bg-surface-muted px-3 py-2 text-[12px] text-ink-muted">
              <TriangleAlert className="h-3.5 w-3.5 text-warning" /> {result.disclaimer}
            </p>
          )}

          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-[14px]">Keywords ({filteredKeywords.length})</CardTitle>
                <Select value={intentFilter} onValueChange={setIntentFilter}>
                  <SelectTrigger className="h-8 w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All intents</SelectItem>
                    {INTENTS.map((i) => (
                      <SelectItem key={i} value={i}>{i}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {filteredKeywords.map((k, i) => (
                  <span key={`${k.term}-${i}`} className="rounded-full bg-surface-muted px-2.5 py-1 text-[12px] text-ink">
                    {k.term}
                    <span className="ml-1.5 text-[10px] text-ink-subtle">{k.intent}</span>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {(
              [
                ["Product angles", result.productAngles],
                ["Audience & gifting angles", result.audienceAngles],
                ["Seasonal ideas", result.seasonalIdeas],
              ] as const
            ).map(([title, items]) => (
              <Card key={title}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-1.5 text-[13px]">
                    <Lightbulb className="h-3.5 w-3.5 text-forest" /> {title}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {items.map((item, i) => (
                      <li key={i} className="text-[12px] leading-relaxed text-ink-muted">• {item}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-[13px]">Title drafts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.titleDrafts.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md bg-surface-muted px-2.5 py-1.5">
                    <span className="text-[12px] text-ink">{t}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-ink-subtle">{t.length}/140</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-[13px]">Description draft</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea defaultValue={result.descriptionDraft} className="min-h-[200px] text-[12px]" />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-[13px]">Tags ({result.tags.length}/13)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {result.tags.map((t, i) => (
                  <span key={i} className={cn("rounded-full px-2.5 py-1 text-[12px]", t.length > 20 ? "bg-danger-soft text-danger" : "bg-forest-soft text-forest")}>
                    {t} · {t.length}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : !status?.configured && !error ? (
        <EmptyState
          icon={<Sparkles />}
          title="AI features need a provider"
          description="Add an AI API key to .env.local to research keywords and draft listings. Upload, edit, batch, templates and exports all work without it."
        />
      ) : null}

      {/* Saved research */}
      {saved && saved.length > 0 && (
        <>
          <h2 className="mb-2 mt-8 text-[15px] font-semibold text-ink">Saved SEO templates</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {saved.map((t) => (
              <Card key={t.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{t.name}</div>
                  <div className="text-[11px] text-ink-subtle">
                    {t.payload.type === "seo"
                      ? `${t.payload.keywords.length} keywords · ${t.payload.titleDrafts.length} titles · ${t.payload.tags.length} tags`
                      : ""}{" "}
                    · updated {formatDateTime(t.updatedAt)}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={async () => { await db.templates.delete(t.id); toast.success("Deleted"); }}>
                  Delete
                </Button>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}