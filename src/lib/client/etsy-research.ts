"use client";

// ---------------------------------------------------------------------------
// Etsy research from the browser: API first, extension second.
//
// The API path is preferred because it returns real tags and Etsy's total
// active-listing count. When the keystring is missing or rejected, the
// companion extension opens the public Etsy search page in a background tab
// that uses the user's own Etsy session and scrapes the cards it displayed.
//
// This is honest browser automation, not server-side scraping: a Cloudflare
// Worker cannot run a browser, and the app never holds an Etsy password or
// token. If neither path is available, the error says exactly what to do.
// ---------------------------------------------------------------------------

import { authedFetch } from "@/lib/client/integrations";
import {
  buildEtsyBrowserResearch,
  type EtsyBrowserCard,
} from "@/lib/etsy/browser-research";
import type { EtsyResearch, EtsyResearchResponse } from "@/types/etsy";

const EXTENSION_TIMEOUT_MS = 45_000;

/** True when the companion extension's content script has marked the page. */
export function etsyExtensionReady(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-mockup-studio-ext") === "1"
  );
}

interface EtsyExtensionDetail {
  requestId?: string;
  ok?: boolean;
  cards?: EtsyBrowserCard[];
  error?: string;
  blocked?: string;
  pageUrl?: string;
}

function requestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `etsy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Asks the extension to read one Etsy search page.
 *
 * Resolves with the scraped cards. Rejects with an actionable message for a
 * verification wall, a closed/blocked page, or no answer at all.
 */
function researchWithExtension(query: string): Promise<EtsyBrowserCard[]> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Browser research needs a browser tab."));
      return;
    }
    const id = requestId();
    let settled = false;

    const cleanup = () => {
      window.removeEventListener("mockup-studio:etsy-research-result", onResult as EventListener);
      window.removeEventListener("mockup-studio:etsy-research-error", onError as EventListener);
      window.clearTimeout(timer);
    };
    const finish = (error: Error | null, cards?: EtsyBrowserCard[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(cards ?? []);
    };

    const onResult = (event: Event) => {
      const detail = (event as CustomEvent).detail as EtsyExtensionDetail | undefined;
      if (!detail || detail.requestId !== id) return;
      if (detail.ok === false) {
        finish(new Error(detail.error ?? "The Etsy research tab failed."));
        return;
      }
      if (detail.blocked) {
        finish(new Error(detail.blocked));
        return;
      }
      finish(null, Array.isArray(detail.cards) ? detail.cards : []);
    };
    const onError = (event: Event) => {
      const detail = (event as CustomEvent).detail as EtsyExtensionDetail | undefined;
      if (!detail || detail.requestId !== id) return;
      finish(new Error(detail.error ?? "The Etsy research tab failed."));
    };
    const timer = window.setTimeout(() => {
      finish(
        new Error(
          "The Etsy tab did not answer in time. Open etsy.com once, finish any verification it asks for, then try again.",
        ),
      );
    }, EXTENSION_TIMEOUT_MS);

    window.addEventListener("mockup-studio:etsy-research-result", onResult as EventListener);
    window.addEventListener("mockup-studio:etsy-research-error", onError as EventListener);
    window.dispatchEvent(
      new CustomEvent("mockup-studio:etsy-research-request", {
        detail: { query, requestId: id },
      }),
    );
  });
}

/**
 * Researches one Etsy query.
 *
 * The API failure is not swallowed: if the browser fallback is also
 * unavailable, the thrown message contains both the reason the API did not
 * answer and what the user can do about it.
 */
export async function researchEtsy(query: string): Promise<EtsyResearch> {
  const clean = query.trim().replace(/\s+/g, " ");
  if (clean.length < 2) throw new Error("An Etsy search query of at least 2 characters is required.");

  let apiError: string | undefined;
  try {
    const response = await authedFetch("/api/etsy/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: clean }),
    });
    const data = (await response.json().catch(() => null)) as EtsyResearchResponse | null;
    if (response.ok && data?.research) return data.research;
    apiError = data?.error ?? `Etsy API research failed (HTTP ${response.status}).`;
  } catch (error) {
    apiError = error instanceof Error ? error.message : "Etsy API research failed.";
  }

  if (etsyExtensionReady()) {
    const cards = await researchWithExtension(clean);
    if (!cards.length) {
      throw new Error(
        `The Etsy search page showed no listing cards for “${clean}”.${
          apiError ? ` The API also failed: ${apiError}` : ""
        }`,
      );
    }
    return buildEtsyBrowserResearch(clean, cards);
  }

  throw new Error(
    `${apiError ?? "Etsy API research is not configured."} Add an Etsy keystring in Settings → API connections, or install the companion extension and open etsy.com once so it can read the public search page in your browser.`,
  );
}
