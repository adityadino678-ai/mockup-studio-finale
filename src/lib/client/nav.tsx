import * as React from "react";

/**
 * Navigation helpers that replace the `next/link` / `next/navigation` surface.
 *
 * Astro serves one document per route, so navigation must be a real document
 * load — `history.pushState` alone would change the URL while leaving the
 * current view on screen. These helpers therefore do plain browser navigation
 * and read the current location straight from the browser.
 */

type AnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
};

export const Link = React.forwardRef<HTMLAnchorElement, AnchorProps>(function Link(
  { prefetch: _prefetch, replace: _replace, scroll: _scroll, ...rest },
  ref,
) {
  return <a {...rest} ref={ref} />;
});

export interface NavigateOptions {
  replace?: boolean;
  scroll?: boolean;
}

export function navigate(href: string, { replace }: NavigateOptions = {}) {
  if (typeof window === "undefined") return;
  if (replace) window.location.replace(href);
  else window.location.assign(href);
}

export function usePathname(): string {
  return window.location.pathname;
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export interface AppRouter {
  push(href: string, options?: NavigateOptions): void;
  replace(href: string, options?: NavigateOptions): void;
  back(): void;
  refresh(): void;
}

export function useRouter(): AppRouter {
  return React.useMemo(
    () => ({
      push: (href) => navigate(href),
      replace: (href) => navigate(href, { replace: true }),
      back: () => window.history.back(),
      refresh: () => window.location.reload(),
    }),
    [],
  );
}
