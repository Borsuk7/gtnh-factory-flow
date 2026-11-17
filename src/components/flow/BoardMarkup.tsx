"use client";

import { useRef, useState } from "react";
import { AppWindow, Eraser, Hexagon, ImagePlus, LoaderCircle, MoveUpRight, Paintbrush, Square, Type, X } from "lucide-react";
import type { FactoryNodeColorTag } from "@/lib/model/types";
import { tipAttrs } from "./clean/interaction";
import { GT_NODE_COLORS, GT_NODE_COLOR_PALETTE } from "./node-colors";

const DRAW_TOOLS = [
  { kind: "board", label: "Draw board", Icon: AppWindow },
  { kind: "box", label: "Draw box", Icon: Square },
  { kind: "zone", label: "Draw zone", Icon: Hexagon },
  { kind: "arrow", label: "Draw arrow", Icon: MoveUpRight },
  { kind: "text", label: "Add text note", Icon: Type },
] as const;

export type BoardDrawTool = (typeof DRAW_TOOLS)[number]["kind"];

export interface BoardMarkupTools {
  brushChoice: FactoryNodeColorTag | null;
  paintMode?: FactoryNodeColorTag | null;
  annotationTool?: BoardDrawTool;
  onAnnotationToolChange: (tool: BoardDrawTool | undefined) => void;
  onPaintModeChange: (tag: FactoryNodeColorTag | null | undefined) => void;
  onBrushSelect: (tag: FactoryNodeColorTag | null) => void;
  onPlaceImage: (file: File) => Promise<void>;
}

const ROW = "flex min-h-8 w-full items-center gap-2 border-2 border-[var(--mc-15)] bg-[var(--mc-49)] px-2 text-left font-mono text-[11px] font-semibold text-white hover:bg-[var(--mc-61)] aria-pressed:border-cyan-300";
const SWATCH = "flex aspect-square min-w-0 items-center justify-center border-2 border-[var(--mc-15)] shadow-[inset_1px_1px_0_rgba(255,255,255,0.45),inset_-1px_-1px_0_rgba(0,0,0,0.45)] aria-pressed:border-white aria-pressed:ring-1 aria-pressed:ring-cyan-300";

export function BoardMarkup({
  tools,
  onClose,
}: {
  tools: BoardMarkupTools;
  onClose: () => void;
}) {
  const { brushChoice, paintMode, annotationTool } = tools;
  const painting = paintMode !== undefined;
  const PaintIcon = painting ? X : brushChoice === null ? Eraser : Paintbrush;
  const paintLabel = painting ? "Stop painting" : brushChoice === null ? "Erase card colours" : "Paint cards";

  return (
    <div className="grid gap-0.5 p-1">
      {DRAW_TOOLS.map(({ kind, label, Icon }) => (
        <button
          key={kind}
          type="button"
          className={ROW}
          aria-pressed={annotationTool === kind}
          onClick={() => {
            tools.onAnnotationToolChange(annotationTool === kind ? undefined : kind);
            onClose();
          }}
        >
          <Icon size={14} aria-hidden />
          {label}
        </button>
      ))}
      <div className="my-0.5 border-t-2 border-[var(--mc-15)]" />
      <button
        type="button"
        className={ROW}
        aria-pressed={painting}
        {...tipAttrs({ id: "markup|paint", title: paintLabel, sub: painting ? "Esc" : "Then click a card" })}
        onClick={() => {
          tools.onPaintModeChange(painting ? undefined : brushChoice);
          onClose();
        }}
      >
        <PaintIcon size={14} aria-hidden />
        {paintLabel}
        {brushChoice !== null ? (
          <span
            aria-hidden
            className="ml-auto size-3.5 border-2 border-[var(--mc-15)]"
            style={{ backgroundColor: GT_NODE_COLORS[brushChoice].swatch }}
          />
        ) : null}
      </button>
      <div className="grid grid-cols-9 gap-0.5 px-0.5 py-0.5" aria-label="Paint colours" role="group">
        <button
          type="button"
          className={`${SWATCH} bg-[var(--mc-49)] text-white`}
          title="Select eraser"
          aria-label="Select eraser"
          aria-pressed={brushChoice === null}
          onClick={() => tools.onBrushSelect(null)}
        >
          <X size={12} aria-hidden />
        </button>
        {GT_NODE_COLOR_PALETTE.map(({ tag, color }) => (
          <button
            key={tag}
            type="button"
            className={SWATCH}
            style={{ backgroundColor: color.swatch }}
            title={`Select ${tag}`}
            aria-label={`Select ${tag}`}
            aria-pressed={brushChoice === tag}
            onClick={() => tools.onBrushSelect(tag)}
          />
        ))}
      </div>
      <div className="my-0.5 border-t-2 border-[var(--mc-15)]" />
      <AddImageButton onPlaceImage={tools.onPlaceImage} />
    </div>
  );
}

function AddImageButton({ onPlaceImage }: Pick<BoardMarkupTools, "onPlaceImage">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          // Picking the same file twice still fires change.
          event.currentTarget.value = "";
          if (!file) return;
          setBusy(true);
          try {
            await onPlaceImage(file);
          } finally {
            setBusy(false);
          }
        }}
      />
      <button type="button" className={ROW} disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : <ImagePlus size={14} aria-hidden />}
        {busy ? "Adding image…" : "Add an image"}
      </button>
    </>
  );
}
