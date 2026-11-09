import * as React from "react";
import { useScrollProgress } from "@/lib/motion";
import { SketchButton } from "./button";

export interface SketchNavLink {
  href: string;
  label: string;
}

const DEFAULT_LINKS: SketchNavLink[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/faq", label: "FAQ" },
];

/**
 * Sticky sketchbook nav with the thin orange scroll-progress line.
 *
 * `loginHref={null}` hides the log-in link instead of shipping a dead one.
 * Both account entry points open the landing page's auth dialog through its
 * query parameters (`/?auth=in` / `/?auth=up`); there is deliberately no
 * standalone /login page. The label and destination of the primary button are
 * props for the same reason: some pages open the login-free Studio instead.
 */
export function SketchNav({
  links = DEFAULT_LINKS,
  logoHref = "/",
  loginHref = "/?auth=in",
  loginLabel = "Log in",
  signupHref = "/?auth=up",
  signupLabel = "Start free",
}: {
  links?: SketchNavLink[];
  logoHref?: string;
  loginHref?: string | null;
  loginLabel?: string;
  signupHref?: string;
  signupLabel?: string;
}) {
  const ref = useScrollProgress<HTMLElement>();

  return (
    <nav ref={ref} className="sk-nav" aria-label="Main">
      <a className="sk-nav__logo" href={logoHref}>
        List<b>/</b>Bulkly
      </a>
      {links.map((link) => (
        <a key={link.href} className="sk-nav__link" href={link.href}>
          {link.label}
        </a>
      ))}
      {loginHref ? (
        <a className="sk-nav__link" href={loginHref}>
          {loginLabel}
        </a>
      ) : null}
      <SketchButton href={signupHref} size="sm">
        {signupLabel}
      </SketchButton>
    </nav>
  );
}
