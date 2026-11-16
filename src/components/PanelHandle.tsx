"use client";

import "./panel-handle.css";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { tipAttrs } from "@/components/flow/clean/interaction";
import { getUiScale } from "@/lib/ui-scale";

/** A key press moves the edge this far (shell px); with Shift, more. */
const KEY_STEP = 16;
const KEY_STEP_SHIFT = 64;

export interface PanelHandleProps {
  /** What it resizes, for the name a screen reader reads and the tip. */
  label: string;
  /** The column's edge it sits on: the right edge of a column left of the board, the left edge of one right of it. */
  edge: "left" | "right";
  /** The column's width now (shell px). */
  getWidth: () => number;
  /** What the column can be dragged to now (shell px). */
  getLimits: () => { min: number; max: number };
  /** A press begins a drag. */
  onStart?: () => void;
  /** The pointer moved: this is the width the column should show (shell px). Nothing is saved yet. */
  onDrag: (width: number) => void;
  /** The drag ended, or a key set a width: save it. */
  onCommit: (width: number) => void;
  /** A double click: back to the default width. */
  onReset: () => void;
  /** The drag is over (committed or not). */
  onEnd?: () => void;
}

/**
 * The thin strip on a side column's board-side edge that drags it wider or narrower (double-click for the default;
 * arrow keys when it has the focus). The pointer is in REAL px and the widths in SHELL px, so a move is divided by the
 * interface size (src/components/AGENTS.md). A drag only reports widths: the workspace writes them straight onto its
 * grid and saves the last, so nothing re-renders while the pointer moves and the board is not rebuilt.
 */
export function PanelHandle({ label, edge, getWidth, getLimits, onStart, onDrag, onCommit, onReset, onEnd }: PanelHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; width: number; min: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Dragging toward the board makes its column narrower.
  const sign = edge === "right" ? 1 : -1;

  const finish = (save: boolean) => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (current && save && current.width !== current.startWidth) onCommit(current.width);
    onEnd?.();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    const { min, max } = getLimits();
    const startWidth = getWidth();
    drag.current = { startX: event.clientX, startWidth, width: startWidth, min, max };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
    onStart?.();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const moved = (event.clientX - current.startX) / getUiScale();
    const width = Math.round(Math.min(current.max, Math.max(current.min, current.startWidth + sign * moved)));
    if (width === current.width) return;
    current.width = width;
    onDrag(width);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    const { min, max } = getLimits();
    const now = getWidth();
    // Arrow keys point the way the edge moves: right on a column's right edge widens it.
    const toward = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    let next: number | undefined;
    if (toward !== 0) next = now + toward * sign * step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter" || event.key === "Escape") return;
    if (next === undefined) return;
    event.preventDefault();
    const width = Math.round(Math.min(max, Math.max(min, next)));
    if (width === now) return;
    onStart?.();
    onDrag(width);
    onCommit(width);
    onEnd?.();
  };

  const { min, max } = getLimits();
  return (
    <div
      className="panel-handle"
      data-edge={edge}
      data-dragging={dragging ? "" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={getWidth()}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => {
        if (drag.current) finish(true);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset();
      }}
      onKeyDown={onKeyDown}
      {...tipAttrs({ id: `panel-handle|${label}`, title: label, sub: "Drag to resize, double-click for the default" })}
    />
  );
}
