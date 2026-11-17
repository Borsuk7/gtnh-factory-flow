"use client";

import "./chrome.css";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";
import { activateOnKey } from "@/lib/hooks/button-keys";
import { getUiScale } from "@/lib/ui-scale";

/**
 * The mod draws its bar, tabs and menus in GUI pixels at GUI scale 2: two screen pixels each. This file's sizes are
 * GUI pixels in css px under the interface's 1.17, so the bar and its menus wear 2 / 1.17 more (chrome.css).
 */
export const CHROME_SCREEN_K = 2 / 1.17;
import { playBoardSound } from "@/lib/board-sounds";
import { tipAttrs } from "@/components/flow/clean/interaction";
import { PixelIcon } from "./pixel-icons";

/** Where a menu hangs from, in real (unzoomed) screen pixels. */
export interface ChromeAnchor {
  left: number;
  top: number;
  bottom: number;
  right?: number;
}

export function chromeAnchorOf(element: Element): ChromeAnchor {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, right: r.right };
}

/** A row of a menu: its label, a quiet detail at the right, and what it does. */
export interface MenuEntry {
  label: string;
  detail?: string;
  tone?: "red";
  current?: boolean;
  disabled?: boolean;
  /** The row opens another page in the same menu. */
  keepOpen?: boolean;
  /** A thin rule above this row. */
  ruleAbove?: boolean;
  /** A tooltip: why a greyed row does nothing, or more about what it does. */
  tip?: string;
  /** A small coloured dot before the label (a task's status). */
  dot?: string;
  /** A plus before the label: the row makes something new. */
  plus?: boolean;
  /** A picture before the label. */
  icon?: ReactNode;
  /** A font-family for the label alone (the font picker shows each font in itself). */
  labelFont?: string;
  onSelect: () => void;
}

/** The attribute that makes a press on an element count as inside the menu it opens (the key toggles it). */
export const MENU_ANCHOR_ATTR = "data-menu-anchor";

/**
 * The mod's PickList in Popup's frame: rows 20 high, the label left, the detail right in muted ink, the hovered
 * row lit, the current one shaded. A body portal closed by Escape, a press outside, a scroll or the camera
 * moving (the app's one dropdown rule); picking a row closes it, then does what the row says.
 */
export function ChromeMenu({
  anchor,
  entries,
  label,
  title,
  minWidth,
  align = "left",
  zIndex,
  fitViewport = false,
  onClose,
}: {
  anchor: ChromeAnchor;
  entries: MenuEntry[];
  label: string;
  title?: string;
  minWidth?: number;
  /** `right` hangs the menu's right edge from the anchor's right edge (the keys at the bar's end). */
  align?: "left" | "right";
  /** Over a column that stacks above the bar's menus (the items column). */
  zIndex?: number;
  fitViewport?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDropdownDismiss(true, {
    refs: [ref],
    onClose,
    insideSelector: `[${MENU_ANCHOR_ATTR}]`,
  });
  // Keyboard: focus moves into the menu (the first row), and goes back to the key that opened it on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    const rows = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled])');
    (rows?.[0] ?? menu)?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      // Only take focus back when it was in the menu (a row picked that opened something else keeps its own).
      if (previous?.isConnected && (!active || active === document.body || menu?.contains(active))) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);
  // The menu wears the bar's extra zoom (chrome.css .mm, CHROME_SCREEN_K): its box is in those pixels.
  const scale = getUiScale() * CHROME_SCREEN_K;
  const shell = (px: number) => px / scale;
  const vw = shell(window.innerWidth);
  const spaceBelow = shell(window.innerHeight - anchor.bottom) - 8;
  const spaceAbove = shell(anchor.top) - 8;
  const above = fitViewport && spaceBelow < entries.length * 20 + 24 && spaceAbove > spaceBelow;
  const style: React.CSSProperties = {
    minWidth: fitViewport ? Math.min(minWidth ?? 100, vw - 8) : minWidth ?? 100,
    ...(fitViewport ? { maxWidth: Math.min(360, vw - 8) } : {}),
    maxHeight: fitViewport ? Math.max(0, above ? spaceAbove : spaceBelow) : Math.max(80, spaceBelow),
    ...(above ? { bottom: shell(window.innerHeight - anchor.top) + 2 } : { top: shell(anchor.bottom) + 2 }),
    ...(zIndex === undefined ? {} : { zIndex }),
  };
  // The menu's width is only known once it is drawn, so one wider than the room on its side (a right-hung menu
  // near the window's left edge, as the items column's is) is slid back inside the window before it paints.
  const [slide, setSlide] = useState(0);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 2 * scale;
    if (box.left < margin) {
      setSlide(shell(margin - box.left));
    } else if (box.right > window.innerWidth - margin) {
      setSlide(-Math.min(shell(box.right - (window.innerWidth - margin)), shell(box.left - margin)));
    }
    // Measured once as it opens: a menu closes on a scroll or a camera move, so its anchor does not move under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (align === "right" && anchor.right !== undefined) {
    style.right = Math.max(2, vw - shell(anchor.right)) - slide;
  } else {
    style.left = Math.max(2, shell(anchor.left)) + slide;
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-mod-menu=""
      className="mm ui-zoom nodrag nowheel"
      style={style}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      tabIndex={-1}
      onKeyDown={(event) => {
        const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled])') ?? [])];
        const at = rows.indexOf(document.activeElement as HTMLElement);
        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (step) {
          event.preventDefault();
          rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
        } else if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {title ? <div className="mm-title">{title}</div> : null}
      <div className="mm-scroll">
        {entries.map((entry, index) => (
          <MenuRow key={`${entry.label}:${index}`} entry={entry} onClose={onClose} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function MenuRow({ entry, onClose }: { entry: MenuEntry; onClose: () => void }): ReactNode {
  return (
    <>
      {entry.ruleAbove ? <div className="mm-rule" /> : null}
      <div
        role="menuitem"
        className="mm-row"
        tabIndex={-1}
        onKeyDown={activateOnKey}
        data-tone={entry.tone}
        data-current={entry.current ? "" : undefined}
        data-off={entry.disabled ? "" : undefined}
        aria-disabled={entry.disabled || undefined}
        {...(entry.tip ? tipAttrs({ id: `menu|${entry.label}`, title: entry.tip }) : {})}
        onClick={() => {
          if (entry.disabled) return;
          playBoardSound("tick");
          if (!entry.keepOpen) onClose();
          entry.onSelect();
        }}
      >
        {entry.dot ? <span className="mm-dot" style={{ background: entry.dot }} aria-hidden /> : null}
        {entry.plus ? <PixelIcon name="plus" className="mm-plus" /> : null}
        {entry.icon ?? null}
        <span className="mm-label" style={entry.labelFont ? { fontFamily: entry.labelFont } : undefined}>
          {entry.label}
        </span>
        {entry.detail ? <span className="mm-detail">{entry.detail}</span> : null}
      </div>
    </>
  );
}
