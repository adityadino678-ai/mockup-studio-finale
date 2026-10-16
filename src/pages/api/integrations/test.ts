import type { APIRoute } from "astro";
import { json } from "@/lib/server/env";
import { credentialsFromRequest } from "@/lib/server/creds";
import { probePrintify, PrintifyError } from "@/lib/server/printify";
import { probeAi } from "@/lib/server/ai";

// Live connection test. Reads credentials from the request headers (the key the
// visitor pasted in Settings) with a fallback to server secrets, then makes a
// real, read-only call to the provider. Nothing is persisted.
export const prerender = false;

interface TestRequest {
  provider?: "printify" | "ai";
}

export const POST: APIRoute = async ({ request }) => {
  let body: TestRequest = {};
  try {
    body = (await request.json()) as TestRequest;
  } catch {
    // Body is optional; the provider may also be inferred by the client.
  }

  const creds = credentialsFromRequest(request);
  const provider = body.provider;

  if (provider === "printify") {
    if (!creds.printify) {
      return json(
        { ok: false, configured: false, provider, message: "Paste your Printify API key first." },
        400,
      );
    }
    try {
      const probe = await probePrintify(creds.printify.apiKey);
      const message = probe.shopCount
        ? `Connected — ${probe.shopCount} shop${probe.shopCount === 1 ? "" : "s"} available${
            probe.shopTitle ? ` (${probe.shopTitle})` : ""
          }.`
        : "Key accepted, but this account has no shops connected yet.";
      return json({
        ok: true,
        configured: true,
        provider,
        source: creds.printify.source,
        message,
        detail: probe,
      });
    } catch (error) {
      const status = error instanceof PrintifyError ? error.status : 502;
      return json(
        {
          ok: false,
          configured: true,
          provider,
          message: error instanceof Error ? error.message : "Printify request failed",
        },
        status === 501 ? 503 : 502,
      );
    }
  }

  if (provider === "ai") {
    if (!creds.ai) {
      return json(
        { ok: false, configured: false, provider, message: "Paste your AI API key (and base URL / model) first." },
        400,
      );
    }
    try {
      const probe = await probeAi(creds.ai);
      const message =
        probe.mode === "models"
          ? `Connected — ${creds.ai.model}${probe.modelCount != null ? ` · ${probe.modelCount} models available` : ""}.`
          : `Connected — ${creds.ai.model} replied in ${probe.ms} ms.`;
      return json({
        ok: true,
        configured: true,
        provider,
        source: creds.ai.source,
        message,
        detail: { ...probe, baseUrl: creds.ai.baseUrl },
      });
    } catch (error) {
      return json(
        {
          ok: false,
          configured: true,
          provider,
          message: error instanceof Error ? error.message : "AI request failed",
        },
        502,
      );
    }
  }

  return json({ error: "Unknown provider. Use \"printify\" or \"ai\"." }, 400);
};
