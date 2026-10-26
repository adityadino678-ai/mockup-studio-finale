"use client";

// ---------------------------------------------------------------------------
// The companion extension's presence and capability.
//
// The content script marks the document and announces itself. The marker alone
// is not enough to trust the extension: an older build also marks the page, but
// it merges mockups instead of replacing them and may not understand the Etsy
// request at all. It would then either do the wrong thing or wait for a reply
// that never comes.
//
// The protocol attribute is the capability check. `EXTENSION_PROTOCOL` is the
// version this app needs:
//
//   2  replacement apply (the payload's `replace` flag) + Etsy research
//
// An extension that is present but older is reported as "reload it" rather than
// treated as absent or left to time out.
// ---------------------------------------------------------------------------

/** The protocol this app needs from the extension. */
export const EXTENSION_PROTOCOL = 2;

export const EXTENSION_MARKER = "data-mockup-studio-ext";
export const EXTENSION_PROTOCOL_ATTR = "data-mockup-studio-ext-protocol";
export const EXTENSION_ETSY_ATTR = "data-mockup-studio-ext-etsy";
export const EXTENSION_VERSION_ATTR = "data-mockup-studio-ext-version";

export interface CompanionExtension {
  /** The content script ran on this page. */
  present: boolean;
  /** 0 when an older build only set the marker. */
  protocol: number;
  /** The build advertises Etsy research. */
  etsy: boolean;
  /** The manifest version, when the build reports it. */
  version: string;
}

function protocolNumber(value: string | null): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Read the extension's markers from the current document. */
export function companionExtension(): CompanionExtension {
  if (typeof document === "undefined") {
    return { present: false, protocol: 0, etsy: false, version: "" };
  }
  const root = document.documentElement;
  return {
    present: root.getAttribute(EXTENSION_MARKER) === "1",
    protocol: protocolNumber(root.getAttribute(EXTENSION_PROTOCOL_ATTR)),
    etsy: root.getAttribute(EXTENSION_ETSY_ATTR) === "1",
    version: root.getAttribute(EXTENSION_VERSION_ATTR) ?? "",
  };
}

/** True when the extension is installed AND speaks the protocol this app needs. */
export function extensionReady(): boolean {
  const extension = companionExtension();
  return extension.present && extension.protocol >= EXTENSION_PROTOCOL;
}

/** True when an extension is installed but too old for this app. */
export function extensionOutdated(): boolean {
  const extension = companionExtension();
  return extension.present && extension.protocol < EXTENSION_PROTOCOL;
}

/** True when the extension can answer an Etsy research request. */
export function etsyExtensionReady(): boolean {
  const extension = companionExtension();
  return (
    extension.present &&
    extension.protocol >= EXTENSION_PROTOCOL &&
    extension.etsy
  );
}

/** One sentence that tells the user exactly what to do about an old build. */
export function extensionReloadMessage(): string {
  return "The companion extension is installed but out of date. Open chrome://extensions (or edge://extensions), press Reload on Mockup Studio Printify Bridge, then reload this page.";
}
