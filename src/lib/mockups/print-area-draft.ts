// ---------------------------------------------------------------------------
// The own-mockup print-area write.
//
// Every incidental print-area write - the debounced autosave, the pending
// draft flushed on a tab switch, the unmount flush and "Save on this mockup" -
// touches THIS mockup only. The frame the user is dragging belongs to the
// photo they are dragging it on, and copying it to the siblings is an explicit
// decision: "Render on every mockup" is the ONLY action that propagates, and
// it passes its own scope ("category") to `applyPrintAreaToMockups` directly.
//
// Keeping the write in one function means the three component flush sites and
// the unit tests cannot drift apart about which scope a normal save uses.
// ---------------------------------------------------------------------------

import { applyPrintAreaToMockups } from "@/lib/mockups/propagate";
import type { MockupPrintArea } from "@/types/domain";

export async function savePrintAreaDraft(params: {
  sourceMockupId: string;
  designId?: string;
  area: MockupPrintArea;
}): Promise<{ updated: number; mockupIds: string[] }> {
  return applyPrintAreaToMockups({
    sourceMockupId: params.sourceMockupId,
    designId: params.designId,
    area: params.area,
    // "this" is the point of this module: a normal save never leaves the mockup.
    scope: "this",
  });
}
