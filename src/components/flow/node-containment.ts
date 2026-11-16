"use client";

import { useEffect, type RefObject } from "react";
import { virtualizationEnabled } from "./virtual/card-virtualizer";

/**
 * CARDS OFF SCREEN COST NOTHING TO STYLE, LAYOUT OR PAINT.
 *
 * React Flow culling is off (routes must not depend on mount state, see
 * AGENTS.md invariant 1), so every card of a plan is in the DOM and, without
 * this, the browser styles, lays out, layerizes and hit-tests all of them on
 * every frame: a 1,000-card plan is 190,000 elements and a zoom frame took
 * 1.2 s. `content-visibility: auto` lets the browser skip the contents of
 * the cards the camera cannot see while the nodes stay mounted, so React Flow
 * keeps its measured boxes and the router its published geometry.
 *
 * What makes it safe, and what this file does about each:
 *
 * - A skipped card keeps the box it had when it was last drawn
 *   (`contain-intrinsic-size: auto W H`), but a card that was NEVER drawn
 *   would take the fallback W H and React Flow would measure that. So a card
 *   is marked (`data-cv`, the attribute the CSS hangs off; React owns
 *   className) only once it has been laid out, with its own size as the
 *   fallback. The sweep reads every box first and writes after, so it is one
 *   layout however many cards there are.
 * - Paint containment clips; `overflow-clip-margin` (node-containment.css)
 *   leaves room for the selection ring and the halos. Hovered, selected,
 *   dragged and focused cards are exempt, so menus and hover panels that
 *   leave the card are never clipped.
 * - Nothing may read a skipped card's inner geometry: the contents have no
 *   boxes. `isCardSkipped` is for the readers that would (the slot
 *   measurement in FactoryFlow.tsx); `holdCard` drops the skip for a frame
 *   for a caller that has to measure.
 *
 * `localStorage["gtnh-factory-flow.no-cv"] = "1"` turns it off (A/B, bugs).
 */

/** The attribute marking a card the browser may skip when it is off screen. */
export const CONTAINMENT_ATTRIBUTE = "data-cv";
/** On a card: suspends the skip for it (see holdCard). On the board: for every card (export). */
export const CONTAINMENT_HOLD_ATTRIBUTE = "data-cv-hold";

const DISABLE_KEY = "gtnh-factory-flow.no-cv";

function disabled(): boolean {
  // Cards that are not near the screen have no contents at all (virtual/), so there is nothing left to skip;
  // content-visibility stays for the board that turns the shell off.
  if (virtualizationEnabled()) {
    return true;
  }
  try {
    return window.localStorage.getItem(DISABLE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the card's contents are being skipped right now (marked, and the
 * browser has decided it is off screen). Reading a descendant's rectangle of
 * such a card gives zeros.
 */
export function isCardSkipped(card: Element): boolean {
  if (!card.hasAttribute(CONTAINMENT_ATTRIBUTE) || card.hasAttribute(CONTAINMENT_HOLD_ATTRIBUTE)) {
    return false;
  }
  // The card itself is never "skipped"; its contents are, so ask a child.
  const inner = card.firstElementChild as
    | (Element & { checkVisibility?: (options?: object) => boolean })
    | null;
  // checkVisibility is Chromium 105+. Without it there is nothing to ask, and
  // a browser that lacks it mostly lacks content-visibility too.
  if (!inner?.checkVisibility) {
    return false;
  }
  return !inner.checkVisibility({ contentVisibilityAuto: true });
}

/**
 * Lifts the skip from one card for a moment, so a caller can measure inside it
 * (React Flow's handle measurement reads descendant rectangles). The layout
 * flush the caller's own read triggers does the rest.
 */
export function holdCard(card: Element | null): void {
  if (!card || !card.hasAttribute(CONTAINMENT_ATTRIBUTE)) {
    return;
  }
  card.setAttribute(CONTAINMENT_HOLD_ATTRIBUTE, "");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => card.removeAttribute(CONTAINMENT_HOLD_ATTRIBUTE)),
  );
}

/** holdCard for the card with this node id, if it is on the board. */
export function holdCardById(nodeId: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const quoted = nodeId.replace(/["\\]/g, "\\$&");
  holdCard(document.querySelector(`.react-flow__node[data-id="${quoted}"]`));
}

/** Marks every laid-out, unmarked card in `cards`. Reads all boxes, then writes. */
export function markCards(cards: Iterable<HTMLElement>): number {
  const ready: Array<[HTMLElement, number, number]> = [];
  for (const card of cards) {
    if (!card.isConnected || card.hasAttribute(CONTAINMENT_ATTRIBUTE)) {
      continue;
    }
    // Layout size, not the screen rectangle: no transform or zoom in it.
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (width > 0 && height > 0) {
      ready.push([card, width, height]);
    }
  }
  for (const [card, width, height] of ready) {
    card.style.setProperty("--cv-w", `${width}px`);
    card.style.setProperty("--cv-h", `${height}px`);
    card.setAttribute(CONTAINMENT_ATTRIBUTE, "");
  }
  return ready.length;
}

/**
 * Marks cards as the board mounts them. Called once, from the board root.
 *
 * A card is marked two frames and a beat after it appears: long enough for
 * React Flow's ResizeObserver to have measured it at its real size.
 */
export function useNodeContainment(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const board = ref.current;
    if (!board || disabled()) {
      return;
    }
    let observer: MutationObserver | undefined;
    let timer: number | undefined;
    let frame = 0;
    let retries = 0;
    const pending = new Set<HTMLElement>();

    const flush = () => {
      markCards(pending);
      // Cards that never laid out (a hidden tab) stay pending for the next round.
      for (const card of [...pending]) {
        if (!card.isConnected || card.hasAttribute(CONTAINMENT_ATTRIBUTE)) {
          pending.delete(card);
        }
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(flush);
        });
      }, 100);
    };
    const adopt = (node: Node) => {
      if (node instanceof HTMLElement && node.classList.contains("react-flow__node")) {
        pending.add(node);
      }
    };

    const attach = () => {
      const nodesLayer = board.querySelector(".react-flow__nodes");
      if (!nodesLayer) {
        if (retries++ < 40) {
          timer = window.setTimeout(attach, 250);
        }
        return;
      }
      for (const child of Array.from(nodesLayer.children)) {
        adopt(child);
      }
      observer = new MutationObserver((records) => {
        for (const record of records) {
          record.addedNodes.forEach(adopt);
        }
        if (pending.size > 0) {
          schedule();
        }
      });
      observer.observe(nodesLayer, { childList: true });
      if (pending.size > 0) {
        schedule();
      }
    };
    attach();

    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [ref]);
}
