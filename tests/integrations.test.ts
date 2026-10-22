import { beforeEach, describe, expect, it } from "vitest";

/**
 * `astro:env/server` is aliased to a stub in `vitest.config.mts` that reads
 * `process.env`, so the server credential resolver's rules (browser header wins,
 * server fallback, provider registry) are unit testable without booting Astro.
 */
import { credentialsFromRequest, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from "@/lib/server/creds";
import {
  EMPTY_INTEGRATIONS,
  integrationHeaders,
  migrateIntegrations,
  selectModel,
} from "@/lib/client/integrations";
import { getProvider, normalizeModels, providerList } from "@/lib/ai/providers";

function req(headers: Record<string, string>): Request {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  } as unknown as Request;
}

describe("credentialsFromRequest", () => {
  beforeEach(() => {
    for (const key of ["PRINTIFY_API_KEY", "AI_API_KEY", "OPENAI_API_KEY", "AI_BASE_URL", "AI_MODEL"]) {
      delete process.env[key];
    }
  });

  it("reports nothing configured when there are no headers or secrets", () => {
    const creds = credentialsFromRequest(req({}));
    expect(creds.printify).toBeUndefined();
    expect(creds.ai).toBeUndefined();
  });

  it("prefers a browser-supplied key and marks its source", () => {
    process.env.PRINTIFY_API_KEY = "server-key";
    const creds = credentialsFromRequest(req({ "x-printify-key": "browser-key" }));
    expect(creds.printify).toEqual({ apiKey: "browser-key", source: "browser" });
  });

  it("falls back to the server secret when the browser sends no key", () => {
    process.env.PRINTIFY_API_KEY = "server-key";
    const creds = credentialsFromRequest(req({}));
    expect(creds.printify).toEqual({ apiKey: "server-key", source: "server" });
  });

  it("resolves the base URL from the provider registry", () => {
    const creds = credentialsFromRequest(
      req({ "x-ai-key": "k", "x-ai-provider": "groq", "x-ai-model": "llama-3.3-70b-versatile" }),
    );
    expect(creds.ai).toEqual({
      apiKey: "k",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      provider: "groq",
      source: "browser",
    });
  });

  it("lets a request override the base URL (custom provider)", () => {
    const creds = credentialsFromRequest(
      req({ "x-ai-key": "k", "x-ai-provider": "custom", "x-ai-base-url": "https://my.host/v1" }),
    );
    expect(creds.ai?.provider).toBe("custom");
    expect(creds.ai?.baseUrl).toBe("https://my.host/v1");
  });

  it("uses a server base URL as a custom provider fallback", () => {
    process.env.AI_API_KEY = "srv";
    process.env.AI_BASE_URL = "https://corp.example/v1";
    const creds = credentialsFromRequest(req({}));
    expect(creds.ai?.provider).toBe("custom");
    expect(creds.ai?.baseUrl).toBe("https://corp.example/v1");
    expect(creds.ai?.source).toBe("server");
  });

  it("defaults the base URL and model for a bare AI key", () => {
    const creds = credentialsFromRequest(req({ "x-ai-key": "k" }));
    expect(creds.ai?.provider).toBe("custom");
    expect(creds.ai?.baseUrl).toBe(DEFAULT_AI_BASE_URL);
    expect(creds.ai?.model).toBe(DEFAULT_AI_MODEL);
  });

  it("ignores blank headers so the server secret can still apply", () => {
    process.env.AI_API_KEY = "server-ai";
    const creds = credentialsFromRequest(req({ "x-ai-key": "   " }));
    expect(creds.ai).toEqual({
      apiKey: "server-ai",
      baseUrl: DEFAULT_AI_BASE_URL,
      model: DEFAULT_AI_MODEL,
      provider: "custom",
      source: "server",
    });
  });
});

describe("integrationHeaders", () => {
  it("emits the active provider even with no keys", () => {
    expect(integrationHeaders(EMPTY_INTEGRATIONS)).toEqual({
      "x-ai-provider": "custom",
    });
  });

  it("emits provider-scoped headers and a base-URL override for custom", () => {
    const headers = integrationHeaders({
      printifyKey: "  pp_live  ",
      activeProvider: "custom",
      activeModel: "",
      providers: { custom: { apiKey: "sk-x", baseUrl: " https://x/v1 ", model: "my-model" } },
    });
    expect(headers).toEqual({
      "x-printify-key": "pp_live",
      "x-ai-provider": "custom",
      "x-ai-base-url": "https://x/v1",
      "x-ai-key": "sk-x",
      "x-ai-model": "my-model",
    });
  });

  it("does not leak a base-URL override for a known provider", () => {
    const headers = integrationHeaders({
      printifyKey: "",
      activeProvider: "nvidia",
      activeModel: "meta/llama-3.1-8b-instruct",
      providers: { nvidia: { apiKey: "nvapi-x", baseUrl: "https://evil.example/v1" } },
    });
    expect(headers["x-ai-base-url"]).toBeUndefined();
    expect(headers["x-ai-key"]).toBe("nvapi-x");
  });
});

describe("migrateIntegrations", () => {
  it("lifts a legacy single-key config into the custom provider", () => {
    const migrated = migrateIntegrations({
      printifyKey: "pp",
      aiKey: "old-key",
      aiBaseUrl: "https://old.example/v1",
      aiModel: "old-model",
    });
    expect(migrated.printifyKey).toBe("pp");
    expect(migrated.activeProvider).toBe("custom");
    expect(migrated.activeModel).toBe("old-model");
    expect(migrated.providers.custom).toEqual({
      apiKey: "old-key",
      baseUrl: "https://old.example/v1",
      model: "old-model",
    });
  });

  it("keeps the new multi-provider shape intact", () => {
    const migrated = migrateIntegrations({
      printifyKey: "",
      activeProvider: "groq",
      activeModel: "llama-3.3-70b-versatile",
      providers: { groq: { apiKey: "g" }, openrouter: { apiKey: "o" } },
    });
    expect(migrated.activeProvider).toBe("groq");
    expect(migrated.providers.openrouter.apiKey).toBe("o");
  });
});

describe("selectModel", () => {
  it("sets the active model and stores it on the provider", () => {
    const base = migrateIntegrations({
      activeProvider: "groq",
      activeModel: "",
      providers: { groq: { apiKey: "g" } },
    });
    const next = selectModel(base, "llama-3.3-70b-versatile");
    expect(next.activeModel).toBe("llama-3.3-70b-versatile");
    expect(next.providers.groq.model).toBe("llama-3.3-70b-versatile");
  });
});

describe("provider registry", () => {
  it("ships the 14 providers in priority order", () => {
    const ids = providerList().map((p) => p.id);
    expect(ids).toHaveLength(14);
    expect(ids.slice(0, 3)).toEqual(["nvidia", "openrouter", "groq"]);
    expect(ids.at(-1)).toBe("custom");
  });

  it("tags free models from real pricing (OpenRouter)", () => {
    const def = getProvider("openrouter")!;
    const models = normalizeModels(def, {
      data: [
        { id: "meta/llama-3.3-70b:free", name: "Llama free", pricing: { prompt: "0", completion: "0" }, context_length: 131072 },
        { id: "openai/gpt-4o", name: "GPT-4o", pricing: { prompt: "0.000005", completion: "0.000015" }, context_length: 128000 },
        { id: "text-embedding-3-large", name: "Embed", pricing: { prompt: "0", completion: "0" } },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["meta/llama-3.3-70b:free", "openai/gpt-4o"]);
    expect(models[0].free).toBe(true);
    expect(models[1].free).toBe(false);
    expect(models[0].contextLength).toBe(131072);
  });

  it("tags suffix-marked free models and marks whole free-tier providers", () => {
    const together = getProvider("together")!;
    const togetherModels = normalizeModels(together, {
      data: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free" }, { id: "Qwen/Qwen2.5-7B-Instruct-Turbo" }],
    });
    expect(togetherModels.find((m) => m.id.includes("Llama"))?.free).toBe(true);
    expect(togetherModels.find((m) => m.id.includes("Qwen"))?.free).toBe(false);

    const groq = getProvider("groq")!;
    const groqModels = normalizeModels(groq, { data: [{ id: "llama-3.3-70b-versatile" }] });
    expect(groqModels[0].free).toBe(true);
  });
});

describe("POST /api/printify/products", () => {
  it("refuses more than Printify's 100-variant limit before calling Printify", async () => {
    const { POST } = await import("@/pages/api/printify/products");
    const ids = Array.from({ length: 130 }, (_, i) => i + 1);
    const request = new Request("http://localhost/api/printify/products", {
      method: "POST",
      headers: { "content-type": "application/json", "x-printify-key": "test-key" },
      body: JSON.stringify({
        confirm: true,
        title: "Too many",
        blueprintId: 6,
        printProviderId: 30,
        variants: { "6": ids },
        price: 1999,
      }),
    });
    const response = await POST({ request } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("at most 100 variants");
    expect(body.error).toContain("130");
  });
});

describe("the background remover needs no credentials", () => {
  it("sends no background-removal headers", () => {
    // The remover runs entirely in the browser with the two local engines.
    // There is no service to call, so there is no header to send and no key
    // to leak.
    const headers = integrationHeaders({
      printifyKey: "pp",
      activeProvider: "custom",
      activeModel: "",
      providers: {},
    });
    expect(Object.keys(headers).some((h) => h.includes("bg-remove"))).toBe(false);
  });

  it("ignores a background-removal section left by an older version", () => {
    // An older build stored `bgRemove` in IndexedDB. Loading it must not
    // resurrect a setting the app no longer has - and must not crash.
    const migrated = migrateIntegrations({
      printifyKey: "pp",
      activeProvider: "groq",
      bgRemove: { provider: "photoroom", apiKey: "left-over" },
    });
    expect(migrated.printifyKey).toBe("pp");
    expect(migrated.activeProvider).toBe("groq");
    expect(Object.prototype.hasOwnProperty.call(migrated, "bgRemove")).toBe(false);
  });
});
