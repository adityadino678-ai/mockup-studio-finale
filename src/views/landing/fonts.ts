/**
 * Legacy font declarations kept for the onboarding wizard.
 *
 * The public landing page is now a standalone document with its own font link.
 * The app itself reads the design-system custom properties, so these names
 * simply point at those tokens instead of duplicating font stacks.
 */
export const fonts = {
  heading: "var(--font-display)",
  body: "var(--font-body)",
};
