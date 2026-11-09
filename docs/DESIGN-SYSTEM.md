# The Sketchbook — design system (Phase 1)

Approved visual reference: the `index.html` sketchbook landing page supplied by the
product owner. Match it; do not redesign it.

## Files

| File | What it owns |
|---|---|
| `src/styles/tokens.css` | The only colour, type, spacing, shape and motion values |
| `src/styles/sketch.css` | Every sketch component class, keyframes, responsive and reduced-motion rules |
| `src/config/brand.ts` | The same five hex values for places CSS cannot reach (meta, manifest, OG, email) |
| `src/lib/motion/index.ts` | The one motion library: `useInkScene`, `useScrollProgress`, `useReducedMotion` |
| `src/lib/sketch/slogan.ts` | Three-line slogan split, font sizing, 22-character clamp |
| `src/components/sketch/*` | All components (see below) |
| `src/layouts/SketchLayout.astro` | Paper page shell: self-hosted fonts, tokens, rough filter, grain |
| `src/pages/styleguide.astro` + `src/views/styleguide/styleguide-page.tsx` | Live catalogue of the system (`noindex`) |

The existing tools still use the old Tailwind theme in `src/styles/globals.css`.
That is deliberate: Phase 1 adds the new system without touching working app
logic or visuals. Phase 5 moves the tools onto the sketch system.

## Rules

1. **Five colours only** — `--paper #F7F3EC`, `--ink #15110E`, `--blue #3F63C9`,
   `--orange #E8702A`, `--wash #DDE5F7`. No other hex values, no gradients.
2. **No page defines its own colour, font or spacing.** Read the custom
   properties. `tests/sketch-tokens.test.ts` fails if a sixth colour appears.
3. **Orange** is for oversized display type, stripes and button fills. Body copy
   is ink on paper; text on blue is paper.
4. **Hairline rules, not boxed cards.** Square corners everywhere.
5. **Fonts are self-hosted** (`@fontsource-variable/josefin-sans`,
   `@fontsource-variable/caveat`) with system fallbacks. No Google Fonts request.
6. **The tee print is always a three-line slogan**, middle line on an orange
   block. Never a sun or generic icon; no trademarks, brands, celebrities or
   copyrighted characters.
7. **Placeholders are labelled `PLACEHOLDER`** wherever a price, limit or
   destination is not final. No invented statistics, ratings or testimonials.

## Components

`SketchNav` (sticky, orange scroll-progress line), `SketchFooter`, `Marquee`,
`SketchButton` (solid/outline, sm/md/lg, block, loading, disabled),
`SketchInput` / `SketchTextarea` / `SketchSelect` / `SketchRange` /
`SketchCheckbox` / `SketchSeg` (labels, hints, accessible errors),
`SketchRows` + `SketchRow` (hairline lists), `.sk-plan` (pricing row),
`.sk-faq` (details/summary), `SketchDialog` (native `<dialog>`),
`SketchToastProvider` + `useSketchToast`, `SketchSkeleton` (opacity pulse),
`InkDraw` (self-drawing scene), `InkWash` (rough blob), `SketchDefs` (rough
filter), `Grain`, `Tee3D` (`hero` turning / `fixed` / `loader`), `TeeLoader`,
`SketchEmpty`, `PartHeader` (01–06 numerals with rough orange stripe),
`SketchAppShell` (tool chrome, wired into the real views in Phase 5).

## Motion contract

- Server markup is **fully drawn**. Nothing is hidden until JS runs, so a failed
  script or disabled JS never blanks a scene.
- `useInkScene` adds `.sk-anim` (arms the hidden start state) then `.sk-in`
  (plays) at 30% visibility. Both classes land on the **same** element, so the
  play selectors are `.sk-in .sk-f` / `.sk-in .sk-d`, never a descendant pair.
- Only `transform`, `opacity` and `stroke` animate. One purposeful loop per
  scene: the tee turn, the marquee, the slogan nudge.
- `prefers-reduced-motion: reduce` shows everything, animates nothing, and the
  tee loader and skeleton stop too.
- The scroll-progress line writes `--sk-progress` through `requestAnimationFrame`;
  it never triggers a React render.

## Accessibility notes

- Ink on paper ≈ 16:1, paper on blue ≈ 4.9:1, blue on paper ≈ 4.9:1 — all AA.
- **Orange on paper measures ≈ 2.8:1**, below the 3:1 large-text threshold. It
  is used exactly as the approved design uses it (oversized display type,
  stripes, button fills where the label is ink). Never use orange for body text,
  hints, errors or output numbers. Fixing this strictly would need a darker
  orange, which is a brand decision for the owner.
- Error messages are ink with an orange marker square, not orange text.
- The native dialog supplies focus trapping, Escape and backdrop dismissal.
- Every input has a real `<label>`; errors use `role="alert"` and
  `aria-describedby`.

## Verify

```powershell
npm run dev -- --port 3000     # http://localhost:3000/styleguide
npx vitest run tests/sketch-slogan.test.ts tests/sketch-tokens.test.ts
node tmp/sketch-shots.mjs      # screenshots + console/mobile/reduced-motion/no-JS checks
```
