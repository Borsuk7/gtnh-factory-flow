"use client";

import "./menus.css";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";
import { getUiScale } from "@/lib/ui-scale";

/** Where a menu hangs from, in real (unzoomed) screen pixels. */
export interface MenuAnchor {
  left: number;
  top: number;
  bottom: number;
  right?: number;
}

export function anchorOf(element: Element): MenuAnchor {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, right: r.right };
}

/** Marks a menu panel that sibling menus (the settings sheet and its option list) count as inside. */
export const KEEP_ATTR = "data-cm-keep";

/**
 * The shell every clean-card menu shares: a body portal in the tooltip skin under (or over) its anchor, closed by
 * Escape, a press outside, a scroll or the camera moving (the app's one dropdown rule). Nothing of it is in the card's
 * DOM. `width` and `maxHeight` are shell pixels; the anchor is real pixels.
 */
export function MenuPortal({
  anchor,
  width,
  maxHeight,
  label,
  onClose,
  className,
  keepOpenOn,
  role = "menu",
  align = "left",
  children,
}: {
  anchor: MenuAnchor;
  width: number;
  maxHeight: number;
  label: string;
  onClose: () => void;
  className?: string;
  /** A selector for elements a press on counts as inside (the anchor, a parent sheet). */
  keepOpenOn?: string;
  role?: "menu" | "dialog";
  align?: "left" | "right";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDropdownDismiss(true, {
    refs: [ref],
    onClose,
    insideSelector: [`[${KEEP_ATTR}]`, "[data-menu-anchor]", keepOpenOn].filter(Boolean).join(","),
  });
  useEffect(() => {
    if (role !== "dialog") return;
    const previous = document.activeElement;
    const panel = ref.current;
    if (!panel?.contains(previous)) panel?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (previous instanceof HTMLElement && previous.isConnected &&
        (panel?.contains(active) || active === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [role]);
  const scale = getUiScale();
  const shell = (px: number) => px / scale;
  const vw = shell(window.innerWidth);
  const spaceBelow = shell(window.innerHeight - anchor.bottom) - 12;
  const spaceAbove = shell(anchor.top) - 12;
  const below = spaceBelow >= Math.min(maxHeight, 200) || spaceBelow >= spaceAbove;
  const w = Math.min(width, vw - 16);
  const left = align === "right" ? shell(anchor.right ?? anchor.left) - w : shell(anchor.left);
  return createPortal(
    <div
      ref={ref}
      role={role}
      tabIndex={role === "dialog" ? -1 : undefined}
      aria-label={label}
      data-cm=""
      {...{ [KEEP_ATTR]: "" }}
      className={`ui-zoom nodrag nowheel cm ${className ?? ""}`}
      style={{
        width: w,
        left: Math.max(8, Math.min(left, vw - w - 8)),
        ...(below
          ? { top: shell(anchor.bottom) + 2, maxHeight: Math.min(maxHeight, spaceBelow) }
          : { bottom: shell(window.innerHeight - anchor.top) + 2, maxHeight: Math.min(maxHeight, spaceAbove) }),
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
