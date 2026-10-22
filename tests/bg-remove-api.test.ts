import { describe, expect, it } from "vitest";

/**
 * The hosted background-removal endpoint.
 *
 * The providers are reached over the network, so what is under test here is
 * everything that can be checked without it: the request each provider is
 * sent, how a key is resolved, and how the answers are read. The endpoint
 * itself was verified live against a real provider.
 */
import {
  DEFAULT_GEMINI_MODEL,
  ENGINE_HEADER,
  GEMINI_MODELS_URL,
  PHOTOROOM_URL,
  REMOVE_BG_URL,
  base64ToBytes,
  buildGeminiRequest,
  buildPhotoRoomRequest,
  buildRemoveBgRequest,
  extractGeminiImage,
  extractGeminiText,
  isPng,
  missingKeyMessage,
  pickProviderMessage,
  sanitizeProviderMessage,
} from "@/pages/api/bg-remove";
import { credentialsFromRequest, parseBgRemoveProvider } from "@/lib/server/creds";

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function req(headers: Record<string, string>): Request {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  } as unknown as Request;
}

describe("the provider requests", () => {
  it("sends the image to remove.bg as a form field with the key in a header", () => {
    const request = buildRemoveBgRequest(PNG_BASE64, "rbg_key");
    expect(request.url).toBe(REMOVE_BG_URL);
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("rbg_key");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // The base64 has + and / in it, so it must be form-encoded - otherwise
    // the provider receives a corrupted image.
    const body = new URLSearchParams(request.init.body as string);
    expect(body.get("image_file")).toBe(PNG_BASE64);
    expect(request.init.body as string).not.toContain("+");
  });

  it("sends the image to PhotoRoom as JSON with the key in a header", () => {
    const request = buildPhotoRoomRequest(PNG_BASE64, "pr_key");
    expect(request.url).toBe(PHOTOROOM_URL);
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("pr_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(request.init.body as string)).toEqual({ image_file: PNG_BASE64 });
  });

  it("sends the image to Gemini with the key in the URL and asks for an image back", () => {
    const request = buildGeminiRequest(PNG_BASE64, "AIza-key", "image/png");
    expect(request.url).toContain(GEMINI_MODELS_URL);
    expect(request.url).toContain(DEFAULT_GEMINI_MODEL);
    expect(request.url).toContain("key=AIza-key");
    const body = JSON.parse(request.init.body as string) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: { responseModalities: string[] };
    };
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
    const parts = body.contents[0].parts;
    expect(parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: PNG_BASE64 } });
    // The instruction is what makes it SEPARATE rather than describe.
    expect(String(parts[1].text)).toMatch(/transparent/i);
  });
});

describe("reading the providers' answers", () => {
  it("decodes a base64 PNG", () => {
    const bytes = base64ToBytes(PNG_BASE64);
    expect(bytes.length).toBeGreaterThan(8);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(isPng(bytes)).toBe(true);
  });

  it("does not mistake another format for a PNG", () => {
    expect(isPng(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("finds the image in Gemini's answer", () => {
    const answer = {
      candidates: [
        { content: { parts: [{ inlineData: { data: PNG_BASE64, mimeType: "image/png" } }] } },
      ],
    };
    expect(extractGeminiImage(answer)).toBe(PNG_BASE64);
    // The snake_case spelling is accepted too.
    const snake = {
      candidates: [{ content: { parts: [{ inline_data: { data: PNG_BASE64 } }] } }],
    };
    expect(extractGeminiImage(snake)).toBe(PNG_BASE64);
    expect(extractGeminiImage({ candidates: [] })).toBeUndefined();
  });

  it("finds Gemini's text when it answered with words instead of an image", () => {
    const answer = { candidates: [{ content: { parts: [{ text: "I cannot do that." }] } }] };
    expect(extractGeminiText(answer)).toBe("I cannot do that.");
    expect(extractGeminiImage(answer)).toBeUndefined();
    expect(extractGeminiText({ candidates: [] })).toBeUndefined();
  });

  it("takes the message out of a provider's error answer", () => {
    expect(pickProviderMessage({ error: "Invalid API key" })).toBe("Invalid API key");
    expect(pickProviderMessage({ detail: "Something went wrong" })).toBe("Something went wrong");
    expect(pickProviderMessage({ errors: [{ message: "Bad request" }] })).toBe("Bad request");
    expect(pickProviderMessage({ nothing: true })).toBeUndefined();
    expect(pickProviderMessage("plain text error")).toBe("plain text error");
  });

  it("never lets a key reach the user", () => {
    // A placeholder, NOT a real key - and deliberately not shaped like one
    // either: a `sk_live_` prefix trips GitHub's push protection, which
    // would block the whole commit.
    const key = "not-a-real-key-abcdefghijklmnopqrstuvwxyz";
    const safe = sanitizeProviderMessage(`The key ${key} was rejected`, key);
    expect(safe).not.toContain(key);
    expect(safe).toContain("[redacted]");
    expect(safe.length).toBeLessThanOrEqual(300);
    // A long opaque token is redacted even when it is not the key itself.
    expect(sanitizeProviderMessage("token ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected", ""))
      .toContain("[redacted]");
  });
});

describe("the credentials for the hosted service", () => {
  it("knows the three providers and refuses anything else", () => {
    expect(parseBgRemoveProvider("remove-bg")).toBe("remove-bg");
    expect(parseBgRemoveProvider("PhotoRoom")).toBe("photoroom");
    expect(parseBgRemoveProvider("gemini")).toBe("gemini");
    // An unknown value must never reach a URL.
    expect(parseBgRemoveProvider("https://evil.example")).toBeUndefined();
    expect(parseBgRemoveProvider(undefined)).toBeUndefined();
  });

  it("uses the browser's key and marks its source", () => {
    const creds = credentialsFromRequest(
      req({ "x-bg-remove-provider": "photoroom", "x-bg-remove-key": "pr_browser" }),
    );
    expect(creds.bgRemove).toEqual({
      apiKey: "pr_browser",
      provider: "photoroom",
      source: "browser",
    });
  });

  it("falls back to the server secret", () => {
    process.env.BG_REMOVE_API_KEY = "srv-key";
    const creds = credentialsFromRequest(req({ "x-bg-remove-provider": "remove-bg" }));
    expect(creds.bgRemove).toEqual({
      apiKey: "srv-key",
      provider: "remove-bg",
      source: "server",
    });
    delete process.env.BG_REMOVE_API_KEY;
  });

  it("uses the AI key for Gemini, because that is the AI Studio key", () => {
    const creds = credentialsFromRequest(
      req({ "x-bg-remove-provider": "gemini", "x-ai-key": "AIza-google" }),
    );
    expect(creds.bgRemove?.apiKey).toBe("AIza-google");
    expect(creds.bgRemove?.provider).toBe("gemini");
  });

  it("reports nothing when no key is configured at all", () => {
    const creds = credentialsFromRequest(req({}));
    expect(creds.bgRemove).toBeUndefined();
  });

  it("says exactly which key is missing", () => {
    expect(missingKeyMessage("remove-bg")).toMatch(/background-removal key/i);
    expect(missingKeyMessage("gemini")).toMatch(/Google AI Studio key/i);
  });
});

describe("the response contract", () => {
  it("names the header the client reads the engine from", () => {
    expect(ENGINE_HEADER).toBe("x-bg-remove-engine");
  });
});
