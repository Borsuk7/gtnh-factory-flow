"use client";

import { useRef, useState } from "react";
import { AppWindow, Hexagon, ImagePlus, LoaderCircle, MoveUpRight, Paintbrush, Square, Type, X } from "lucide-react";
import type { FactoryNodeColorTag } from "@/lib/model/types";
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
  activeColorTag: FactoryNodeColorTag;
  paintMode?: FactoryNodeColorTag | null;
  annotationTool?: BoardDrawTool;
  onAnnotationToolChange: (tool: BoardDrawTool | undefined) => void;
  onPaintModeChange: (tag: FactoryNodeColorTag | null | undefined) => void;
  onColorSelect: (tag: FactoryNodeColorTag) => void;
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
  const { activeColorTag, paintMode, annotationTool } = tools;
  const armPaint = (tag: FactoryNodeColorTag | null | undefined) => {
    if (tag != null) tools.onColorSelect(tag);
    tools.onPaintModeChange(tag);
    onClose();
  };

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
        aria-pressed={paintMode !== undefined}
        onClick={() => armPaint(paintMode === undefined ? activeColorTag : undefined)}
      >
        <Paintbrush size={14} aria-hidden />
        Paint cards
        <span
          aria-hidden
          className="ml-auto size-3.5 border-2 border-[var(--mc-15)]"
          style={{ backgroundColor: GT_NODE_COLORS[activeColorTag].swatch }}
        />
      </button>
      <div className="grid grid-cols-9 gap-0.5 px-0.5 py-0.5" aria-label="Paint colours" role="group">
        <button
          type="button"
          className={`${SWATCH} bg-[var(--mc-49)] text-white`}
          title="Erase colours"
          aria-label="Erase colours"
          aria-pressed={paintMode === null}
          onClick={() => armPaint(null)}
        >
          <X size={12} aria-hidden />
        </button>
        {GT_NODE_COLOR_PALETTE.map(({ tag, color }) => (
          <button
            key={tag}
            type="button"
            className={SWATCH}
            style={{ backgroundColor: color.swatch }}
            title={`Paint ${tag}`}
            aria-label={`Paint ${tag}`}
            aria-pressed={activeColorTag === tag && paintMode !== null}
            onClick={() => armPaint(tag)}
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
