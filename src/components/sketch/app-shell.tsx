import * as React from "react";

export interface SketchShellLink {
  href: string;
  label: string;
}

/**
 * Sketch app shell for the tools (wired into the real views in Phase 5).
 * Dense work stays readable: hairline rules, uppercase labels, one handwritten
 * "how to use this page" hint, and no decorative motion inside the tools.
 */
export function SketchAppShell({
  links,
  activeHref,
  title,
  hint,
  actions,
  children,
}: {
  links: SketchShellLink[];
  activeHref?: string;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="sk-shell">
      <aside className="sk-shell__side">
        <a className="sk-nav__logo" href="/">
          List<b>/</b>Bulkly
        </a>
        <nav aria-label="Workspace">
          <ul className="sk-shell__nav">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  className="sk-shell__link"
                  href={link.href}
                  aria-current={link.href === activeHref ? "page" : undefined}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="sk-shell__body">
        <header className="sk-shell__top">
          <div>
            <h1 className="sk-page-title">{title}</h1>
            {hint ? <p className="sk-page-hint">{hint}</p> : null}
          </div>
          {actions ? <div style={{ marginLeft: "auto" }}>{actions}</div> : null}
        </header>
        <main className="sk-shell__main">{children}</main>
      </div>
    </div>
  );
}
