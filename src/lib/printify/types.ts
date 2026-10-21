// ---------------------------------------------------------------------------
// Printify catalogue and product shapes.
//
// These mirror the v1 API. Everything here is data the API gave us, not
// invented: the catalogue only exposes colour *names*, while a product carries
// the real option values and their hexes. See AGENTS.md ("The Printify
// product contract") for the observed behaviour these types encode.
// ---------------------------------------------------------------------------

/** A printable area on a variant. Sizes are in pixels at the provider's DPI. */
export interface CatalogPlaceholder {
  position: string;
  decoration_method?: string;
  width?: number;
  height?: number;
}

/** A catalogue variant = one concrete colour x size combination. */
export interface CatalogVariant {
  id: number;
  /** "Heather Grey / S" */
  title: string;
  /** v1 gives names, e.g. { color: "Heather Grey", size: "S" }. */
  options?: Record<string, string>;
  placeholders?: CatalogPlaceholder[];
  available?: boolean;
}

export interface CatalogBlueprint {
  id: number;
  title: string;
  brand: string;
  model?: string;
  category?: string;
  image?: string;
  /** The v1 catalogue returns an ARRAY of image urls. */
  images?: string[];
}

export interface CatalogProvider {
  id: number;
  title: string;
  decoration_methods?: string[];
}

/** One selectable value of a product option. `colors` is colour-only. */
export interface ProductOptionValue {
  id: number;
  /** "Heather Grey" */
  title: string;
  /** Real hexes, e.g. ["#a4a4a3", "#B7B6B5"]. Only on colour options. */
  colors?: string[];
}

export interface ProductOption {
  /** "Colors" */
  name: string;
  /** "color" | "size" */
  type: string;
  values: ProductOptionValue[];
  /** Printify marks the option shown in previews - usually the colour one. */
  display_in_preview?: boolean;
}

/** A product variant, with the option VALUE ids it is made of. */
export interface ProductVariant {
  id: number;
  title: string;
  price?: number;
  cost?: number;
  is_enabled?: boolean;
  is_available?: boolean;
  /** Option value ids, e.g. [831, 14] = (Heather Grey, S). */
  options: number[];
}

/** The product shape we need in order to reuse a product as a template. */
export interface PrintifyProduct {
  id: string;
  title: string;
  blueprint_id?: number;
  print_provider_id?: number;
  shop_id?: number;
  visible?: boolean;
  options?: ProductOption[];
  variants?: ProductVariant[];
}

/** An image attached to a print area, with Printify's placement convention. */
export interface PrintAreaImage {
  id: string;
  /** Centre X in [0,1] within the print area. 0.5 = centred. */
  x: number;
  /** Centre Y in [0,1] within the print area. */
  y: number;
  /** Image width as a fraction of the print-area width. */
  scale: number;
  /** Degrees, clockwise. */
  angle: number;
}

export interface PrintAreaPlaceholder {
  position: string;
  images: PrintAreaImage[];
}

export interface PrintAreaGroup {
  variant_ids: number[];
  placeholders: PrintAreaPlaceholder[];
}

/**
 * The colour option of a product, plus the ids of the variants that use each
 * colour. This is the authoritative colour -> variant map; the catalogue's
 * string options are only a convenience.
 */
export interface ColourIndex {
  /** Colour title -> the option value id. */
  valueIds: Map<string, number>;
  /** Colour title -> real hexes (may be empty when the source has none). */
  hexes: Map<string, string[]>;
  /** Colour title -> every variant id with that colour. */
  variantIds: Map<string, number[]>;
  /** Size title -> every variant id with that size. */
  sizes: Map<string, number[]>;
  /** Every variant id of the product. */
  allVariantIds: number[];
}
