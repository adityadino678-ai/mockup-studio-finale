import "fake-indexeddb/auto";

// jsdom lacks canvas/createImageBitmap; the app code paths we unit-test here
// are pure, but the Dexie-backed tests touch blob storage, so provide minimal
// stubs rather than pulling in a full canvas implementation.
if (typeof globalThis.createImageBitmap !== "function") {
  globalThis.createImageBitmap = (async () => {
    throw new Error("createImageBitmap is not available in the unit-test environment");
  }) as unknown as typeof createImageBitmap;
}