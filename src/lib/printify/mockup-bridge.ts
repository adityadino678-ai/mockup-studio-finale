// ---------------------------------------------------------------------------
// The clipboard bridge between Mockup Studio and Printify's web session.
//
// The app can upload images through Printify's public API, but selecting them
// as a product's mockups is only exposed by Printify's web BFF. The app
// therefore builds this plain payload (ids and URLs only - never a credential)
// and the bookmarklet applies it inside the user's own printify.com session.
// ---------------------------------------------------------------------------

export interface PrintifyMockupUpload {
  /** The media-library record id. */
  libraryId: string;
  /** The custom product-mockup id returned by Printify. */
  mockupId: string;
  /** The custom mockup image URL. */
  src: string;
  filename: string;
}

export interface PrintifyBridgeProduct {
  shopId: number;
  productId: string;
  productTitle: string;
  /** In listing order; the first selected image is the main image. */
  uploads: PrintifyMockupUpload[];
}

export interface PrintifyBridgePayload {
  source: "mockup-studio";
  version: 1;
  createdAt: string;
  products: PrintifyBridgeProduct[];
}

export function buildBridgePayload(products: PrintifyBridgeProduct[]): PrintifyBridgePayload {
  return {
    source: "mockup-studio",
    version: 1,
    createdAt: new Date().toISOString(),
    products,
  };
}

export function bridgePayloadJson(payload: PrintifyBridgePayload): string {
  return JSON.stringify(payload, null, 2);
}

export function countBridgeImages(payload: PrintifyBridgePayload): number {
  return payload.products.reduce((sum, product) => sum + product.uploads.length, 0);
}
