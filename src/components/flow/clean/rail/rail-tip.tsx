"use client";

import { createPortal } from "react-dom";
import { wheelChangesValues } from "@/lib/device-settings";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

/**
 * The rail's tooltips, in the clean skin (UI spec section 10): a tip shows once
 * the pointer has rested on the same thing for 800 ms (the mod's `Tip.WAIT`).
 * Moving about on it keeps the wait; moving to another thing, leaving, or
 * pressing a button resets it. Once shown it follows the pointer. A module
 * singleton so a row costs two handlers, not a hook.
 *
 * The board's shared rest-wait (`nei/tip-rest.ts`, work package 6) replaces
 * this when it lands: only `tipProps` and `RailTipHost` are used elsewhere.
 */

export const TIP_WAIT_MS = 800;

export type TipInput = "left" | "right" | "middle" | "wheel" | "drag" | "key";

export interface TipContent {
  title: string;
  sub?: string;
  rows?: Array<[label: string, value: string]>;
  columns?: 2;
  notes?: Array<{ text: string; tone?: "muted" | "warn" | "red" }>;
  actions?: Array<{ input: TipInput; label: string }>;
}

interface Shown {
  id: string;
  content: TipContent;
  x: number;
  y: number;
}

let pending: { id: string; content: () => TipContent; x: number; y: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let shown: Shown | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hideTip(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  pending = undefined;
  if (shown) {
    shown = undefined;
    emit();
  }
}

function enter(id: string, content: () => TipContent, event: ReactPointerEvent) {
  if (event.buttons !== 0) return;
  if (pending?.id === id || shown?.id === id) {
    move(event);
    return;
  }
  hideTip();
  pending = { id, content, x: event.clientX, y: event.clientY };
  timer = setTimeout(() => {
    if (!pending) return;
    shown = { id: pending.id, content: pending.content(), x: pending.x, y: pending.y };
    emit();
  }, TIP_WAIT_MS);
}

function move(event: ReactPointerEvent) {
  if (pending) {
    pending.x = event.clientX;
    pending.y = event.clientY;
  }
  if (shown) {
    shown = { ...shown, x: event.clientX, y: event.clientY };
    emit();
  }
}

/**
 * Handlers for a thing that explains itself: `id` names it (a new id restarts the wait). `hooks` run on the
 * same enter and leave, so a row can light itself without losing its tip.
 */
export function tipProps(
  id: string,
  content: () => TipContent,
  hooks?: { enter?: () => void; leave?: () => void },
) {
  return {
    onPointerEnter: (event: ReactPointerEvent) => {
      hooks?.enter?.();
      enter(id, content, event);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      if (event.buttons !== 0) hideTip();
      else enter(id, content, event);
    },
    onPointerLeave: () => {
      hooks?.leave?.();
      hideTip();
    },
    onPointerDown: () => hideTip(),
  };
}
function InputIcon({ input }: { input: TipInput }) {
  // A 7 x 10 mouse: outline, the pressed part filled.
  const fill = "#F5F5F5";
  const line = "#A3A3A3";
  if (input === "key") {
    return (
      <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
        <rect x="0.5" y="1.5" width="7" height="7" fill="none" stroke={line} />
      </svg>
    );
  }
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
      <path d="M1.5 0.5h5l1 1v7l-1 1h-5l-1-1v-7z" fill="none" stroke={line} />
      {input === "left" || input === "drag" ? (
        <rect x="1" y="1" width="3" height="3.5" fill={fill} />
      ) : null}
      {input === "right" ? <rect x="4" y="1" width="3" height="3.5" fill={fill} /> : null}
      {input === "middle" || input === "wheel" ? (
        <rect x="3.5" y="1" width="1" height="3.5" fill={fill} />
      ) : null}
      {input === "drag" ? <path d="M6 6.5v2M5 7.5l1 1 1-1" stroke={fill} fill="none" /> : null}
    </svg>
  );
}

/** Mount once near the rail: draws the tip that is showing. */
export function RailTipHost() {
  const tip = useSyncExternalStore(
    subscribe,
    () => shown,
    () => undefined,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 300, height: 140 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) setSize({ width: element.offsetWidth, height: element.offsetHeight });
  }, [tip?.content]);
  if (!tip || typeof document === "undefined") return null;
  const { width, height } = size;
  const flipLeft = tip.x + 12 + width > window.innerWidth - 4;
  const flipUp = tip.y + 12 + height > window.innerHeight - 4;
  const style = {
    left: flipLeft ? Math.max(4, tip.x - 12 - width) : tip.x + 12,
    top: flipUp ? Math.max(4, tip.y - 12 - height) : tip.y + 12,
  };
  const { content } = tip;
  // A wheel step is not offered while the wheel changes no value.
  const actions = (content.actions ?? []).filter(
    (action) => action.input !== "wheel" || wheelChangesValues(),
  );
  return createPortal(
    <div ref={ref} className="rail-tip" style={style} role="tooltip" data-tooltip-stop>
      <div className="rail-tip-title">{content.title}</div>
      {content.sub ? <div className="rail-tip-sub">{content.sub}</div> : null}
      {content.rows?.length ? (
        <div className="rail-tip-rows" data-two-columns={content.columns === 2 ? "" : undefined}>
          {content.rows.map(([label, value]) => (
            <div key={label} className="rail-tip-row">
              <span>{label}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {content.notes?.map((note) => (
        <div key={note.text} className="rail-tip-note" data-tone={note.tone}>
          {note.text}
        </div>
      ))}
      {actions.length ? (
        <div className="rail-tip-actions">
          {actions.map((action) => (
            <span key={`${action.input}:${action.label}`} className="rail-tip-action">
              <InputIcon input={action.input} />
              {action.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
