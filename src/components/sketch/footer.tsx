import * as React from "react";

export interface SketchFooterLink {
  href?: string;
  label: string;
  /** Marks a destination that does not exist yet. Never renders a dead link. */
  soon?: boolean;
}

const DEFAULT_LINKS: SketchFooterLink[] = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/refunds", label: "Refunds" },
  { href: "/cookies", label: "Cookies" },
  { href: "/contact", label: "Contact" },
];

export function SketchFooter({
  links = DEFAULT_LINKS,
}: {
  links?: SketchFooterLink[];
}) {
  return (
    <footer className="sk-footer">
      {links.map((link) =>
        link.soon || !link.href ? (
          <span
            key={link.label}
            className="sk-footer__soon"
            aria-disabled="true"
            title="PLACEHOLDER — this page has not been published yet"
          >
            {link.label}
            <small>soon</small>
          </span>
        ) : (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ),
      )}
      <small>
        © {new Date().getFullYear()} ListBulkly. Not affiliated with or endorsed by
        Printify or Etsy.
      </small>
    </footer>
  );
}
