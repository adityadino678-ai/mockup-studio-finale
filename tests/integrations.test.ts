import { beforeEach, describe, expect, it } from "vitest";

/**
 * `astro:env/server` is aliased to a stub in `vitest.config.mts` that reads
 * `process.env`, so the server credential resolver's rules (browser header wins,
 * server fallback, defaults) are unit testable without booting Astro.
 */
import { credentialsFromRequest, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from "@/lib/server/creds";
import { integrationHeaders, EMPTY_INTEGRATIONS } from "@/lib/client/integrations";

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

  it("applies AI defaults and reads browser base URL / model", () => {
    const creds = credentialsFromRequest(
      req({ "x-ai-key": "k", "x-ai-base-url": "https://api.groq.com/openai/v1", "x-ai-model": "llama-3.1-8b" }),
    );
    expect(creds.ai).toEqual({
      apiKey: "k",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.1-8b",
      source: "browser",
    });
  });

  it("defaults the base URL and model for a bare AI key", () => {
    const creds = credentialsFromRequest(req({ "x-ai-key": "k" }));
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
      source: "server",
    });
  });
});

describe("integrationHeaders", () => {
  it("only emits non-empty, trimmed credential headers", () => {
    expect(integrationHeaders(EMPTY_INTEGRATIONS)).toEqual({});
    const headers = integrationHeaders({
      printifyKey: "  pp_live  ",
      aiKey: "",
      aiBaseUrl: " https://x/v1 ",
      aiModel: "",
    });
    expect(headers).toEqual({ "x-printify-key": "pp_live", "x-ai-base-url": "https://x/v1" });
  });
});
