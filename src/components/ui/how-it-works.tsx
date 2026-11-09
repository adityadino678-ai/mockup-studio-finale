"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** One "How it works" button per major page; steps live in the dialog. */
export function HowItWorks({
  title,
  steps,
}: {
  title: string;
  steps: string[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          How it works
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Step by step.</DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
