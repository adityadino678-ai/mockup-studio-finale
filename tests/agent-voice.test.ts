import { describe, expect, it } from "vitest";
import {
  pickVoice,
  recognitionSupported,
  speechTextFromParts,
  synthesisSupported,
} from "@/lib/client/speech";
import type { MessagePart } from "@/types/domain";

describe("speech support detection", () => {
  it("reports recognition support only when the API exists", () => {
    expect(recognitionSupported({} as never)).toBe(false);
    expect(recognitionSupported({ webkitSpeechRecognition: () => {} } as never)).toBe(true);
    expect(recognitionSupported({ SpeechRecognition: () => {} } as never)).toBe(true);
  });

  it("reports synthesis support only when speechSynthesis exists", () => {
    expect(synthesisSupported({} as never)).toBe(false);
    expect(synthesisSupported({ speechSynthesis: {} } as never)).toBe(true);
  });
});

describe("pickVoice", () => {
  const voices = [
    { name: "Kate", lang: "en-GB" },
    { name: "Amelie", lang: "fr-FR" },
    { name: "Sam", lang: "en-US" },
  ];

  it("prefers an exact language match", () => {
    expect(pickVoice(voices, "en-US")?.name).toBe("Sam");
  });

  it("falls back to the same language prefix", () => {
    expect(pickVoice(voices, "en-AU")?.name).toBe("Kate");
  });

  it("falls back to the first voice, or null when there are none", () => {
    expect(pickVoice(voices, "de-DE")?.name).toBe("Kate");
    expect(pickVoice([], "en-US")).toBeNull();
  });
});

describe("speechTextFromParts", () => {
  it("keeps only text parts", () => {
    const parts: MessagePart[] = [
      { type: "reasoning", text: "internal" },
      { type: "text", text: "Hello there" },
      {
        type: "tool",
        call: { id: "c1", name: "summarize_workspace", args: {}, status: "done", result: { designs: 3 } },
      },
    ];
    expect(speechTextFromParts(parts)).toBe("Hello there");
  });

  it("strips code fences, inline code, links, and markdown punctuation", () => {
    const parts: MessagePart[] = [
      {
        type: "text",
        text: "# Heading\n\nUse `npm run build` then see [docs](https://example.com).\n\n```js\nconst x = 1;\n```\n",
      },
    ];
    const spoken = speechTextFromParts(parts);
    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("`");
    expect(spoken).not.toContain("http");
    expect(spoken).not.toContain("#");
    expect(spoken).toContain("npm run build");
    expect(spoken).toContain("docs");
  });

  it("truncates very long replies", () => {
    const parts: MessagePart[] = [{ type: "text", text: "a".repeat(2000) }];
    const spoken = speechTextFromParts(parts, 100);
    expect(spoken.length).toBe(101);
    expect(spoken.endsWith("…")).toBe(true);
  });
});
