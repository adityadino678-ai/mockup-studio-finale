// Server-side Printify API client. The API key is read from the environment
// only â€” it is never sent to the browser. All calls return normalized results
// or throw an error with the provider's message so the UI can report real
// failures instead of pretending success.

import { serverEnv } from "@/lib/server/env";

const PRINTIFY_BASE = "https://api.printify.com/v1";

export class PrintifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PrintifyError";
  }
}

export function isPrintifyConfigured(): boolean {
  return !!serverEnv.printifyApiKey();
}

function headers(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-API-Key": serverEnv.printifyApiKey() ?? "",
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isPrintifyConfigured()) {
    throw new PrintifyError("Printify API key is not configured on the server", 501);
  }
  const res = await fetch(`${PRINTIFY_BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ??
      `Printify request failed with HTTP ${res.status}`;
    throw new PrintifyError(message, res.status, data);
  }
  return data as T;
}

// --- Types (subset of the documented shapes we consume) ---

export interface PrintifyBlueprint {
  id: number;
  title: string;
  brand: string;
  model: string;
  category: string;
  image: string;
}

export interface PrintifyVariantOption {
  id: number;
  title: string;
  options: number[];
  available: boolean;
  price_variant?: number;
}

export interface PrintifyPrintArea {
  id: string;
  title?: string;
  image?: string;
  position?: string;
  width?: number;
  height?: number;
}

export interface PrintifyBlueprintDetail extends PrintifyBlueprint {
  variants: PrintifyVariantOption[];
  print_areas: PrintifyPrintArea[];
}

export interface PrintifyProvider {
  id: number;
  title: string;
}

export interface PrintifyProductCreated {
  id: string;
  title: string;
  permalink?: string;
  print_areas?: Record<string, string>;
}

// --- Endpoints ---

export function listBlueprints(category?: string): Promise<PrintifyBlueprint[]> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  return request<PrintifyBlueprint[]>(`/blueprints${qs}`);
}

export function getBlueprint(id: number): Promise<PrintifyBlueprintDetail> {
  return request<PrintifyBlueprintDetail>(`/blueprints/${id}`);
}

export function listProviders(blueprintId: number): Promise<{ providers: PrintifyProvider[] }> {
  return request<{ providers: PrintifyProvider[] }>(`/blueprints/${blueprintId}/providers`);
}

export async function uploadAsset(file: Blob, filename: string): Promise<{ id: number }> {
  if (!isPrintifyConfigured()) {
    throw new PrintifyError("Printify API key is not configured on the server", 501);
  }
  const form = new FormData();
  form.append("file", file, filename);
  const res = await fetch(`${PRINTIFY_BASE}/assets`, {
    method: "POST",
    headers: { "X-API-Key": serverEnv.printifyApiKey() ?? "" },
    body: form,
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new PrintifyError(
      (data as { message?: string })?.message ?? `Asset upload failed with HTTP ${res.status}`,
      res.status,
      data,
    );
  }
  return data as { id: number };
}

export function createProduct(payload: {
  title: string;
  description: string;
  blueprint_id: number;
  print_provider_id?: number;
  variants: Record<string, number[]>;
  print_areas?: Record<string, string>;
  assets?: Array<{ id: number; type?: string }>;
}): Promise<PrintifyProductCreated> {
  return request<PrintifyProductCreated>("/products", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getShopInfo(): Promise<{ id: number; title: string }> {
  return request<{ id: number; title: string }>("/shops");
}