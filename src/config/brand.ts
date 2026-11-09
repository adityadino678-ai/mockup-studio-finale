/**
 * Brand constants for places CSS cannot reach: <meta> tags, manifests, OG
 * images and email. The stylesheet source of truth is styles/tokens.css and
 * these values mirror it exactly — do not add colours.
 */
export const BRAND = {
  name: "ListBulkly",
  concept: "The Sketchbook",
  paper: "#F7F3EC",
  ink: "#15110E",
  blue: "#3F63C9",
  orange: "#E8702A",
  wash: "#DDE5F7",
  promise: "100 designs on Printify, in one sitting. Nothing publishes until you say so.",
} as const;
