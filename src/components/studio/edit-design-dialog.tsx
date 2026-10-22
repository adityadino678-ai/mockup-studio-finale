"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Tag } from "lucide-react";

export interface EditableDesign {
  id: string;
  name: string;
  tags: string[];
}

/**
 * Renames a design and edits its tags.
 *
 * The tags are one comma-separated field: they are labels the user invents,
 * not a fixed taxonomy, and a free-text field is the only editor that lets
 * them invent one. They are normalised on save (trimmed, lower-cased,
 * de-duplicated) so two spellings of the same tag do not become two chips.
 */
export function EditDesignDialog({
  design,
  onClose,
  onSave,
}: {
  design: EditableDesign | null;
  onClose: () => void;
  onSave: (name: string, tags: string[]) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [tagsText, setTagsText] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (design) {
      setName(design.name);
      setTagsText(design.tags.join(", "));
      setSaving(false);
    }
  }, [design]);

  const save = async () => {
    if (!design || !name.trim()) return;
    setSaving(true);
    try {
      const tags = Array.from(
        new Set(
          tagsText
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
        ),
      );
      await onSave(name.trim(), tags);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!design} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit design</DialogTitle>
          <DialogDescription>
            Rename the design or manage its tags (comma separated).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="design-name">Name</Label>
            <Input id="design-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="design-tags" className="flex items-center gap-1.5">
              <Tag className="h-3 w-3" /> Tags
            </Label>
            <Textarea
              id="design-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="funny, christmas, cat"
              className="min-h-[60px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || saving} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
