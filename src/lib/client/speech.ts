"use client";

// ---------------------------------------------------------------------------
// Voice: thin, typed wrappers over the browser Web Speech API.
//
// The APIs are not in the standard TS DOM lib and are missing on some browsers,
// so everything is feature-detected and degrades to "unsupported" rather than
// throwing. The pure helpers (`pickVoice`, `speechTextFromParts`, the support
// checks) are exported so they can be unit-tested without a browser.
// ---------------------------------------------------------------------------

import type { MessagePart } from "@/types/domain";

interface WindowLike {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  speechSynthesis?: unknown;
}

export function recognitionSupported(win: WindowLike | undefined = globalThis as unknown as WindowLike): boolean {
  return !!win && typeof (win.SpeechRecognition ?? win.webkitSpeechRecognition) === "function";
}

export function synthesisSupported(win: WindowLike | undefined = globalThis as unknown as WindowLike): boolean {
  return !!win && !!win.speechSynthesis && typeof win.speechSynthesis === "object";
}

export interface VoiceLike {
  name: string;
  lang: string;
}

/** Chooses the best available voice for a language tag (exact → prefix → null). */
export function pickVoice(voices: ReadonlyArray<VoiceLike>, lang: string): VoiceLike | null {
  if (voices.length === 0) return null;
  const target = (lang || "").toLowerCase();
  const base = target.split("-")[0];
  const exact = voices.find((v) => v.lang.toLowerCase() === target);
  if (exact) return exact;
  const prefixed = voices.find((v) => v.lang.toLowerCase().startsWith(base));
  return prefixed ?? voices[0];
}

/** Flattens an assistant turn into clean, speakable prose (no code, no markup). */
export function speechTextFromParts(parts: MessagePart[], maxLength = 1200): string {
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export interface Dictation {
  stop(): void;
  abort(): void;
}

export interface DictationHandlers {
  onResult(text: string, isFinal: boolean): void;
  onError(message: string): void;
  onEnd(): void;
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

/**
 * Starts a single dictation session. Returns null when the browser has no
 * speech-recognition support, so callers can hide the mic entirely.
 */
export function startDictation(
  handlers: DictationHandlers,
  lang: string = typeof navigator !== "undefined" ? navigator.language : "en-US",
): Dictation | null {
  const win = globalThis as unknown as WindowLike;
  const Ctor = (win.SpeechRecognition ?? win.webkitSpeechRecognition) as
    | (new () => RecognitionLike)
    | undefined;
  if (typeof Ctor !== "function") return null;

  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event: unknown) => {
    const results = (event as { results?: ArrayLike<{ 0?: { transcript?: string }; isFinal?: boolean }> }).results;
    if (!results) return;
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const transcript = item?.[0]?.transcript ?? "";
      if (transcript) handlers.onResult(transcript, !!item.isFinal);
    }
  };
  recognition.onerror = (event) => handlers.onError(event?.error ?? "speech error");
  recognition.onend = () => handlers.onEnd();

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    },
    abort: () => {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

/** Speaks `text` aloud, cancelling anything already queued. No-op when unsupported. */
export function speak(text: string, options: { lang?: string; rate?: number } = {}): boolean {
  if (!text.trim() || !synthesisSupported()) return false;
  const synth = (globalThis as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (options.lang) utterance.lang = options.lang;
  utterance.rate = options.rate ?? 1;
  const voice = pickVoice(synth.getVoices() as VoiceLike[], options.lang ?? utterance.lang);
  if (voice) {
    const match = synth.getVoices().find((v) => v.name === voice.name);
    if (match) utterance.voice = match;
  }
  synth.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if (synthesisSupported()) {
    (globalThis as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis.cancel();
  }
}
