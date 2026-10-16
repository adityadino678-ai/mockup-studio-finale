// ---------------------------------------------------------------------------
// Minimal Server-Sent Events (SSE) encode/parse helpers.
//
// The agent chat streams responses over SSE: the server writes `event:`/`data:`
// frames and the browser parses them back. This module is isomorphic (no DOM,
// no server-only imports) so the endpoint and the client share one parser and
// the frame format is defined exactly once.
// ---------------------------------------------------------------------------

export interface SseFrame {
  event: string;
  data: string;
}

/** Encodes one SSE frame. Objects are JSON-encoded; strings pass through. */
export function encodeSse(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return null;
  return { event, data: data.join("\n") };
}

/**
 * Incremental SSE parser. Feed it decoded chunks (which may split a frame
 * across reads); it returns only the frames that are fully received.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let match: RegExpMatchArray | null;
    const sep = /\r?\n\r?\n/;
    while ((match = this.buffer.match(sep))) {
      const index = match.index ?? 0;
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + match[0].length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Call at end-of-stream to emit a frame left without a trailing blank line. */
  flush(): SseFrame[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    const frame = rest ? parseFrame(rest) : null;
    return frame ? [frame] : [];
  }
}

/** Parses an `event:`/`data:` JSON payload, returning `null` when malformed. */
export function decodeSseData<T>(frame: SseFrame): T | null {
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    return null;
  }
}
