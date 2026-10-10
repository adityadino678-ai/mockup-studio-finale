"use client";

import * as React from "react";
import type { Transform } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Separator } from "@/components/ui/card";
import { Switch, Slider } from "@/components/ui/primitives";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  FlipHorizontal2,
  FlipVertical2,
  Lock,
  LockOpen,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PropertiesPanelProps {
  transform: Transform;
  behindMockup: boolean;
  lockAspect: boolean;
  onTransform: (t: Transform, record?: boolean) => void;
  onBehindMockup: (v: boolean) => void;
  onLockAspect: (v: boolean) => void;
  onReset: () => void;
}

function NumberField({
  label,
  suffix,
  value,
  onCommit,
  min,
  max,
  step = 1,
}: {
  label: string;
  suffix?: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = React.useState(String(Math.round(value * 100) / 100));
  const isFocused = React.useRef(false);

  React.useEffect(() => {
    if (!isFocused.current) setText(String(Math.round(value * 100) / 100));
  }, [value]);

  return (
    <div className="space-y-1">
      <Label className="text-ink-muted">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          value={text}
          min={min}
          max={max}
          step={step}
          onFocus={() => (isFocused.current = true)}
          onBlur={() => {
            isFocused.current = false;
            const parsed = parseFloat(text);
            if (Number.isFinite(parsed)) onCommit(parsed);
            else setText(String(Math.round(value * 100) / 100));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onChange={(e) => setText(e.target.value)}
          className="h-8 pr-8 text-[13px]"
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-ink-subtle">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

export function PropertiesPanel({
  transform,
  behindMockup,
  lockAspect,
  onTransform,
  onBehindMockup,
  onLockAspect,
  onReset,
}: PropertiesPanelProps) {
  const t = transform;
  const set = (patch: Partial<Transform>, record = true) => onTransform({ ...t, ...patch }, record);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto scroll-thin p-4">
      <section className="space-y-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Position</div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="X"
            suffix="%"
            value={t.x * 100}
            min={-50}
            max={150}
            onCommit={(v) => set({ x: Math.min(1.5, Math.max(-0.5, v / 100)) })}
          />
          <NumberField
            label="Y"
            suffix="%"
            value={t.y * 100}
            min={-50}
            max={150}
            onCommit={(v) => set({ y: Math.min(1.5, Math.max(-0.5, v / 100)) })}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => set({ x: 0.5 })}
            title="Center horizontally"
          >
            <AlignCenterHorizontal className="h-3.5 w-3.5" /> Center X
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => set({ y: 0.5 })}
            title="Center vertically"
          >
            <AlignCenterVertical className="h-3.5 w-3.5" /> Center Y
          </Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Size & rotation</div>
          <Button
            variant="ghost"
            size="icon-sm"
            title={lockAspect ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            onClick={() => onLockAspect(!lockAspect)}
          >
            {lockAspect ? <Lock className="h-3.5 w-3.5 text-forest" /> : <LockOpen className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <NumberField
          label="Width (of mockup)"
          suffix="%"
          value={t.scale * 100}
          min={1}
          max={400}
          onCommit={(v) => set({ scale: Math.min(4, Math.max(0.01, v / 100)) })}
        />
        {!lockAspect && (
          <NumberField
            label="Vertical stretch"
            suffix="×"
            value={t.stretch}
            min={0.1}
            max={10}
            step={0.05}
            onCommit={(v) => set({ stretch: Math.min(10, Math.max(0.1, v)) })}
          />
        )}
        <NumberField
          label="Rotation"
          suffix="°"
          value={t.rotation}
          min={-360}
          max={360}
          onCommit={(v) => set({ rotation: ((v % 360) + 360) % 360 })}
        />
      </section>

      <Separator />

      <section className="space-y-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Flip</div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className={cn("flex-1", t.flipX && "border-forest text-forest")}
            onClick={() => set({ flipX: !t.flipX })}
            title="Flip horizontally"
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" /> Horizontal
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn("flex-1", t.flipY && "border-forest text-forest")}
            onClick={() => set({ flipY: !t.flipY })}
            title="Flip vertically"
          >
            <FlipVertical2 className="h-3.5 w-3.5" /> Vertical
          </Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Opacity</div>
        <Slider
          value={[Math.round(t.opacity * 100)]}
          min={5}
          max={100}
          step={1}
          onValueChange={(v) => set({ opacity: v[0] / 100 }, false)}
          onValueCommit={(v) => set({ opacity: v[0] / 100 }, true)}
        />
        <div className="text-right text-[11px] text-ink-subtle">{Math.round(t.opacity * 100)}%</div>
      </section>

      <Separator />

      <section className="space-y-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Rendering</div>
        <label className="flex items-center justify-between gap-2 text-[13px] text-ink">
          <span>Design behind mockup</span>
          <Switch checked={behindMockup} onCheckedChange={onBehindMockup} />
        </label>
        <p className="text-[11px] leading-relaxed text-ink-muted">
          For transparent mockup PNGs (e.g. folded garments) — renders the artwork behind the photo layer.
        </p>
      </section>

      <Separator />

      <Button variant="outline" size="sm" onClick={onReset}>
        <RotateCcw className="h-3.5 w-3.5" /> Reset placement
      </Button>
    </div>
  );
}
