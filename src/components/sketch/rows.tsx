import * as React from "react";
import { cn } from "@/lib/utils";

/** Hairline rules instead of boxed cards. */
export function SketchRows({ children }: { children: React.ReactNode }) {
  return <div className="sk-rows">{children}</div>;
}

export function SketchRow({
  title,
  children,
  simple = false,
}: {
  title?: string;
  children: React.ReactNode;
  simple?: boolean;
}) {
  return (
    <div className={cn("sk-row", simple && "sk-row--simple")}>
      {title !== undefined ? <h3>{title}</h3> : null}
      <div>{children}</div>
    </div>
  );
}

/** A numbered "Part" heading: oversized numeral over a rough orange stripe. */
export function PartHeader({
  number,
  title,
  caption,
  how,
}: {
  number: string;
  title: string;
  caption?: string;
  how?: string;
}) {
  return (
    <div>
      <span className="sk-num">{number}</span>
      <h2 className="sk-part-title">{title}</h2>
      {caption ? <p className="sk-cap">{caption}</p> : null}
      {how ? <p className="sk-part-how">{how}</p> : null}
    </div>
  );
}
