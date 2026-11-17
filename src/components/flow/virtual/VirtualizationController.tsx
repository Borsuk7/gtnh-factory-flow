"use client";

import { memo, useEffect, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useStoreApi } from "@xyflow/react";
import {
  getPublishedNodeDetailLevel,
  NODE_DETAIL_GLANCE,
  subscribeNodeDetailLevel,
} from "../node-detail";
import { CONTAINMENT_HOLD_ATTRIBUTE } from "../node-containment";
import { boardVirtualizer, virtualizationEnabled } from "./card-virtualizer";
import { boardEdges } from "./board-edges";
import { FAR_ATTRIBUTE } from "./VirtualCard";
import { applyZoomTo, setZoomTargets } from "./zoom-var";

/** On the board while only the camera is moving (virtual.css turns the board's pointer events off). */
export const CAMERA_MOVING_ATTRIBUTE = "data-camera-moving";
/** The camera counts as moving until it has rested this long. */
const CAMERA_REST_MS = 150;
/** A pan takes the pointer once it has moved this many pixels. */
const PAN_CAPTURE_SLOP = 4;

/**
 * Feeds the camera to the virtualizer and runs its steps (card-virtualizer.ts), culls the wires
 * (board-edges.ts), and pins the cards in use. Renders nothing.
 *
 * - The camera is read from React Flow's store, which the scroll camera mirrors onto the page; the view is the
 *   rectangle of flow space the screen shows.
 * - Steps run in requestAnimationFrame, only while something is moving or waiting.
 * - A card under the pointer or holding focus is pinned (one delegated listener on the board), except at the
 *   glance step where a card has no controls to use.
 * - The image export and the screenshot panel set `data-cv-hold` on the board (node-containment.ts): while it
 *   is there every card and every wire is mounted.
 */
export const VirtualizationController = memo(function VirtualizationController({
  boardRef,
}: {
  boardRef: RefObject<HTMLDivElement | null>;
}) {
  const flowStore = useStoreApi();

  useEffect(() => {
    const board = boardRef.current;
    if (!board || !virtualizationEnabled()) {
      return;
    }
    let frame = 0;

    // What the pump cost, for the perf harness (window.__gtnhVirtual.stats()).
    const stats = { pumps: 0, stepMs: 0, stepMax: 0, edgeMs: 0, edgeMax: 0, edgeSets: 0, edgesAdded: 0 };
    const applyEdges = () => {
      const started = performance.now();
      const next = boardEdges.refresh();
      if (next) {
        const before = flowStore.getState().edges.length;
        flowStore.getState().setEdges(next);
        stats.edgeSets += 1;
        stats.edgesAdded += Math.max(0, next.length - before);
      }
      const took = performance.now() - started;
      stats.edgeMs += took;
      stats.edgeMax = Math.max(stats.edgeMax, took);
    };

    // Drawers and special cards keep their contents mounted, so hiding their wrappers when far needs no stand-in:
    // React Flow ignores the zero size, and a measure when they are shown again reads the same contents.
    const farOthers = new Set<string>();
    let previousVisible: ReadonlySet<string> = new Set();
    const wrapperOf = (id: string) =>
      board.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    const isCardWrapper = (element: HTMLElement) =>
      element.classList.contains("react-flow__node-storageNode") || element.classList.contains("react-flow__node-recipeNode");
    const hideOther = (id: string) => {
      const element = wrapperOf(id);
      if (!element || !isCardWrapper(element)) return;
      element.setAttribute(FAR_ATTRIBUTE, "");
      farOthers.add(id);
    };
    const showOther = (id: string) => {
      if (!farOthers.delete(id)) return;
      const element = wrapperOf(id);
      element?.removeAttribute(FAR_ATTRIBUTE);
      if (element) applyZoomTo(element);
    };
    const showAllOthers = () => {
      for (const id of [...farOthers]) showOther(id);
      previousVisible = new Set();
    };
    const applyOthers = () => {
      if (boardVirtualizer.holding()) {
        showAllOthers();
        return;
      }
      if (!boardVirtualizer.hasView()) {
        // A different plan is on the board (or none yet): nothing of the last one stays hidden.
        for (const id of [...farOthers]) showOther(id);
        previousVisible = new Set();
        return;
      }
      const visible = boardVirtualizer.visibleIds();
      if (visible === previousVisible) return;
      const first = previousVisible.size === 0 && farOthers.size === 0;
      if (first) {
        for (const id of boardVirtualizer.geometryIds()) {
          if (!visible.has(id) && !boardVirtualizer.isMember(id)) hideOther(id);
        }
      } else {
        for (const id of visible) if (!previousVisible.has(id)) showOther(id);
        for (const id of previousVisible) {
          if (!visible.has(id) && !boardVirtualizer.isMember(id) && boardVirtualizer.boxOf(id)) hideOther(id);
        }
      }
      previousVisible = visible;
    };
    // Every node wrapper by id, for the zoom variable at the glance step (zoom-var.ts: written on the wrappers the
    // camera can see, not on the board, so a step restyles a few hundred elements and not every wire).
    const wrapperById = new Map<string, HTMLElement>();
    const nodesLayer = board.querySelector(".react-flow__nodes");
    if (nodesLayer) {
      for (const child of Array.from(nodesLayer.children)) {
        const id = child.getAttribute("data-id");
        if (id && child instanceof HTMLElement) wrapperById.set(id, child);
      }
    }
    // The glance faces need the zoom variable only where they can be seen: the screen and a hair past it, not the
    // whole band the shells are kept shown in. A wrapper that comes onto the screen takes it as it arrives.
    const SCREEN_MARGIN = 0.05;
    let onScreen: ReadonlySet<string> = new Set();
    function* screenWrappers(): Generator<HTMLElement> {
      onScreen = boardVirtualizer.idsMeeting(SCREEN_MARGIN);
      for (const id of onScreen) {
        const element = wrapperById.get(id);
        if (element && !element.hasAttribute(FAR_ATTRIBUTE)) yield element;
      }
    }
    setZoomTargets(() => screenWrappers());
    const arrive = () => {
      if (!boardVirtualizer.isGlance()) return;
      const now = boardVirtualizer.idsMeeting(SCREEN_MARGIN);
      for (const id of now) {
        if (onScreen.has(id)) continue;
        const element = wrapperById.get(id);
        if (element && !element.hasAttribute(FAR_ATTRIBUTE)) applyZoomTo(element);
      }
      onScreen = now;
    };
    // A wrapper that appears while its card is far (an undo far away) is hidden at once.
    const wrapperObserver = nodesLayer
      ? new MutationObserver((records) => {
          for (const record of records) {
            record.removedNodes.forEach((removed) => {
              if (!(removed instanceof HTMLElement)) return;
              const id = removed.getAttribute("data-id");
              if (id && wrapperById.get(id) === removed) wrapperById.delete(id);
            });
            record.addedNodes.forEach((added) => {
              if (!(added instanceof HTMLElement)) return;
              const id = added.getAttribute("data-id");
              if (!id) return;
              wrapperById.set(id, added);
              if (farOthers.has(id) && isCardWrapper(added)) added.setAttribute(FAR_ATTRIBUTE, "");
              else applyZoomTo(added);
            });
          }
        })
      : undefined;
    wrapperObserver?.observe(nodesLayer!, { childList: true });

    let prioritizedEdges: typeof boardEdges.shown | undefined;
    const pump = () => {
      frame = 0;
      applyEdges();
      if (prioritizedEdges !== boardEdges.shown) {
        prioritizedEdges = boardEdges.shown;
        boardVirtualizer.prioritizeWireEndpoints(prioritizedEdges);
      }
      const started = performance.now();
      const again = boardVirtualizer.step(started);
      applyOthers();
      arrive();
      const took = performance.now() - started;
      stats.pumps += 1;
      stats.stepMs += took;
      stats.stepMax = Math.max(stats.stepMax, took);
      if (again) {
        schedule();
      }
    };
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(pump);
      }
    };
    boardVirtualizer.wake = schedule;

    let wasGlance = false;
    const feedView = () => {
      const { transform, width, height } = flowStore.getState();
      const zoom = transform[2];
      if (!(zoom > 0) || !(width > 0) || !(height > 0)) {
        return;
      }
      const glance = getPublishedNodeDetailLevel() === NODE_DETAIL_GLANCE;
      boardVirtualizer.setView({ x: -transform[0] / zoom, y: -transform[1] / zoom, w: width / zoom, h: height / zoom }, glance);
      if (glance && !wasGlance && boardVirtualizer.mountedCount() > 0) {
        // The board is about to take the glance look (NodeDetailController sets the attribute right after this
        // call). Every card's contents go FIRST, in this very call: the attribute restyles whatever is under the
        // board, and a hundred mounted cards are five thousand elements, 250 ms of style for contents that are
        // about to be removed.
        boardVirtualizer.step(performance.now());
        try {
          flushSync(() => undefined);
        } catch {
          // Called from inside a React commit: the next frame's pump removes them instead.
        }
      }
      wasGlance = glance;
    };
    feedView();
    // While only the camera moves, the cards and wires take no pointer events (virtual.css): the browser hit-tests
    // every pointer move and wheel tick against everything on screen, 10 ms an event with a thousand shells in view
    // and 2 s of a pan. Not while a wire, a card or a marquee is in hand: those find what is under the pointer.
    let movingTimer: ReturnType<typeof setTimeout> | undefined;
    const stopMoving = () => {
      movingTimer = undefined;
      board.removeAttribute(CAMERA_MOVING_ATTRIBUTE);
    };
    const cameraMoved = (state: ReturnType<typeof flowStore.getState>) => {
      if (movingTimer === undefined) {
        if (state.connection.inProgress || state.userSelectionActive || board.querySelector(".react-flow__node.dragging")) {
          return;
        }
        board.setAttribute(CAMERA_MOVING_ATTRIBUTE, "");
      } else {
        clearTimeout(movingTimer);
      }
      movingTimer = setTimeout(stopMoving, CAMERA_REST_MS);
    };
    const unsubscribeStore = flowStore.subscribe((state, previous) => {
      if (state.transform !== previous.transform || state.width !== previous.width || state.height !== previous.height) {
        feedView();
      }
      if (state.paneDragging && !previous.paneDragging && downPointer !== undefined) panArmed = true;
      if (state.transform !== previous.transform) cameraMoved(state);
      else if (movingTimer !== undefined && (state.connection.inProgress || state.userSelectionActive)) {
        clearTimeout(movingTimer);
        stopMoving();
      }
    });
    const unsubscribeLevel = subscribeNodeDetailLevel(feedView);
    schedule();

    // The export photographs the whole plan.
    let release: (() => void) | undefined;
    const syncHold = () => {
      const held = board.hasAttribute(CONTAINMENT_HOLD_ATTRIBUTE);
      if (held && !release) {
        release = boardVirtualizer.hold();
        showAllOthers();
        const all = boardEdges.compute();
        boardEdges.shown = all;
        flowStore.getState().setEdges(all);
      } else if (!held && release) {
        release();
        release = undefined;
        boardEdges.invalidate();
        schedule();
      }
    };
    const holdObserver = new MutationObserver(syncHold);
    holdObserver.observe(board, { attributes: true, attributeFilter: [CONTAINMENT_HOLD_ATTRIBUTE] });
    syncHold();

    // Pins: the card under the pointer and the card holding focus.
    const idOf = (target: EventTarget | null) =>
      (target as Element | null)?.closest?.(".react-flow__node")?.getAttribute("data-id") ?? undefined;
    let hovered: string | undefined;
    let focused: string | undefined;
    const setHovered = (id: string | undefined) => {
      if (id === hovered) return;
      if (hovered) boardVirtualizer.unpin(hovered);
      hovered = id;
      if (id) boardVirtualizer.pin(id);
    };
    const setFocused = (id: string | undefined) => {
      if (id === focused) return;
      if (focused) boardVirtualizer.unpin(focused);
      focused = id;
      if (id) boardVirtualizer.pin(id);
    };
    const onOver = (event: PointerEvent) => {
      setHovered(boardVirtualizer.isGlance() ? undefined : idOf(event.target));
    };
    const onLeave = () => setHovered(undefined);
    const onFocusIn = (event: FocusEvent) => setFocused(idOf(event.target));
    const onFocusOut = (event: FocusEvent) => {
      if (!idOf(event.relatedTarget)) setFocused(undefined);
    };
    // A press React Flow takes as a camera pan keeps the pointer on the pane (captured as the pan starts): without
    // it the browser hit-tests every move of the pan against everything on screen to find what is under it (1.1 s
    // of a 5 s pan with a thousand cards in view); captured, every move goes straight to the pane.
    // Only once the pointer has moved: a press that does not move is a click, and a middle click (a drawer's rate
    // cleared, a count unpinned) ends on the pane when it is captured, so its auxclick never reaches the control.
    let downPointer: number | undefined;
    let downAt = { x: 0, y: 0 };
    let panArmed = false;
    const onPaneDown = (event: PointerEvent) => {
      downPointer = event.pointerId;
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onPaneMove = (event: PointerEvent) => {
      if (!panArmed || event.pointerId !== downPointer) return;
      if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) < PAN_CAPTURE_SLOP) return;
      panArmed = false;
      const pane = board.querySelector(".react-flow__pane") ?? board;
      try {
        pane.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone.
      }
    };
    const onPaneUp = () => {
      downPointer = undefined;
      panArmed = false;
    };
    board.addEventListener("pointerdown", onPaneDown, true);
    window.addEventListener("pointermove", onPaneMove, true);
    window.addEventListener("pointerup", onPaneUp, true);
    window.addEventListener("pointercancel", onPaneUp, true);
    board.addEventListener("pointerover", onOver);
    board.addEventListener("pointerleave", onLeave);
    board.addEventListener("focusin", onFocusIn);
    board.addEventListener("focusout", onFocusOut);

    // Readout for the perf harness and for checking by hand.
    (window as unknown as { __gtnhVirtual?: unknown }).__gtnhVirtual = {
      mounted: () => boardVirtualizer.mountedCount(),
      edgesShown: () => boardEdges.shown.length,
      edgesAll: () => boardEdges.all.length,
      view: () => boardVirtualizer.viewRect(),
      handleReport: () => {
        const lookup = flowStore.getState().nodeLookup;
        const empty: string[] = [];
        let withBounds = 0;
        for (const [id, node] of lookup) {
          const bounds = node.internals.handleBounds;
          if (bounds && (bounds.source?.length || bounds.target?.length)) withBounds += 1;
          else empty.push(id);
        }
        return { withBounds, empty: empty.length, sample: empty.slice(0, 8), drawn: empty.filter((id) => boardVirtualizer.isDrawn(id)).length };
      },
      stats: () => ({ ...stats, undrawn: boardVirtualizer.undrawnCount() }),
    };

    return () => {
      cancelAnimationFrame(frame);
      boardVirtualizer.wake = undefined;
      unsubscribeStore();
      if (movingTimer !== undefined) clearTimeout(movingTimer);
      board.removeAttribute(CAMERA_MOVING_ATTRIBUTE);
      unsubscribeLevel();
      holdObserver.disconnect();
      wrapperObserver?.disconnect();
      setZoomTargets(undefined);
      for (const id of [...farOthers]) showOther(id);
      release?.();
      setHovered(undefined);
      setFocused(undefined);
      board.removeEventListener("pointerdown", onPaneDown, true);
      window.removeEventListener("pointermove", onPaneMove, true);
      window.removeEventListener("pointerup", onPaneUp, true);
      window.removeEventListener("pointercancel", onPaneUp, true);
      board.removeEventListener("pointerover", onOver);
      board.removeEventListener("pointerleave", onLeave);
      board.removeEventListener("focusin", onFocusIn);
      board.removeEventListener("focusout", onFocusOut);
    };
  }, [boardRef, flowStore]);

  return null;
});
