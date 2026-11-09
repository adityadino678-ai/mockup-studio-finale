/**
 * The one motion library for the sketchbook.
 *
 * Scenes are plain HTML/SVG on the server, so a visitor with JS disabled (or a
 * failed hydration) still sees every stroke. The library only ever ADDS
 * `.sk-anim` (arm the hidden start state) and `.sk-in` (play) to a scene.
 * Reduced motion never arms anything.
 */

import { useEffect, useRef, useState } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/** Live reduced-motion flag; false during SSR so markup stays fully drawn. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

/**
 * `pathLength="1"` makes `stroke-dasharray: 1` mean "the whole path", whatever
 * the real geometry is. Our own SVG components set the attribute in JSX; this
 * helper covers third-party or inline markup passed to <InkDraw>.
 */
export function prepareInkPaths(root: ParentNode): void {
  root.querySelectorAll("path.sk-d").forEach((path) => {
    if (!path.hasAttribute("pathLength")) path.setAttribute("pathLength", "1");
  });
}

/**
 * Attach to a scene element. Adds `.sk-in` once the scene is ~30% visible.
 * Returns the ref to place on the scene root.
 */
export function useInkScene<T extends HTMLElement>(threshold = 0.3) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const scene = ref.current;
    if (!scene) return;

    prepareInkPaths(scene);

    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      scene.classList.add("sk-in");
      return;
    }

    scene.classList.add("sk-anim");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          scene.classList.add("sk-in");
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(scene);

    return () => observer.disconnect();
  }, [threshold]);

  return ref;
}

/**
 * The thin orange line under the nav. Writes `--sk-progress` as a percentage
 * on the nav element; CSS paints it. No state, no re-renders.
 */
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const percent = Math.min(100, Math.max(0, (window.scrollY / max) * 100));
      nav.style.setProperty("--sk-progress", `${percent}%`);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}
