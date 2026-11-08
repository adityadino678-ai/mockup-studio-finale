import * as React from "react";

const DEFAULT_ITEMS = ["Create", "Clean", "Mockup", "Describe", "Check", "Send"];

/** The tilted blue band. Decorative; the words are repeated in the page copy. */
export function Marquee({ items = DEFAULT_ITEMS }: { items?: string[] }) {
  const sequence = `${items.join(" · ")} · `;
  return (
    <div className="sk-mq" aria-hidden="true">
      <div className="sk-mq__track">{sequence.repeat(4)}</div>
    </div>
  );
}
