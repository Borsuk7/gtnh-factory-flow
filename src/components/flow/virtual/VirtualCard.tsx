"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useStoreApi, useUpdateNodeInternals } from "@xyflow/react";
import "./virtual.css";
import { applyZoomTo } from "./zoom-var";
import { syncPromptPhase } from "./prompt-phase";
import { glanceFace } from "../clean/glance";
import { formatSolvedMachines } from "../clean/clean-model";
import { MotionNumberAttribute } from "../board-motion";
import { boardVirtualizer, virtualizationEnabled } from "./card-virtualizer";
import type { ShellFace } from "./use-card-face";

/** A shell that was just shown keeps its handle markers a beat after React Flow measured it, or this long without. */
const MARKER_SETTLE_MS = 120;
const MARKER_GIVE_UP_MS = 2000;

/** The attribute on a far card's React Flow wrapper (virtual.css hides it). */
export const FAR_ATTRIBUTE = "data-vfar";

/**
 * Cards that were just drawn ask React Flow to measure them (its handle boxes need the DOM). One call a frame for
 * all of them: React Flow reads rectangles per handle, and a call per card forced a layout for each (a third of a
 * 1,000-card load).
 *
 * The card counts as drawn (and may then be released to its shell) only once React Flow holds its handle boxes:
 * React Flow measures a frame after it is asked, and a shell measured by then has no handles to give.
 */
type StoreLike = {
  getState: () => {
    nodeLookup: Map<
      string,
      { internals: { handleBounds?: { source?: unknown[]; target?: unknown[] } } }
    >;
  };
};
const measureQueue = new Map<string, { attempts: number; asked: boolean }>();
let measureFrame = 0;
let measureWith: { update: (ids: string[]) => void; store: StoreLike } | undefined;

const MEASURE_ATTEMPTS = 6;

function hasHandles(store: StoreLike, id: string): boolean {
  const bounds = store.getState().nodeLookup.get(id)?.internals.handleBounds;
  return Boolean(bounds && ((bounds.source?.length ?? 0) > 0 || (bounds.target?.length ?? 0) > 0));
}

function flushMeasures(): void {
  measureFrame = 0;
  const target = measureWith;
  if (!target) return;
  // Each card is asked once per round: a second ask while the first is in flight would be read after the card
  // had been released to its shell.
  const ids = [...measureQueue].filter(([, entry]) => !entry.asked).map(([id]) => id);
  if (ids.length === 0) return;
  for (const id of ids) measureQueue.get(id)!.asked = true;
  target.update(ids);
  // React Flow measures in a frame of its own; look at what it holds after that.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const id of ids) {
        const entry = measureQueue.get(id);
        if (!entry) continue;
        entry.attempts += 1;
        if (hasHandles(target.store, id) || entry.attempts >= MEASURE_ATTEMPTS) {
          measureQueue.delete(id);
          boardVirtualizer.markDrawn(id);
        } else {
          entry.asked = false;
        }
      }
      // What did not take is asked again, with the card still in the DOM (it is not released until drawn).
      if (!measureFrame && [...measureQueue.values()].some((entry) => !entry.asked)) {
        measureFrame = requestAnimationFrame(flushMeasures);
      }
    }),
  );
}

function queueMeasure(update: (ids: string[]) => void, store: StoreLike, id: string): void {
  measureWith = { update, store };
  if (!measureQueue.has(id)) measureQueue.set(id, { attempts: 0, asked: false });
  if (!measureFrame) measureFrame = requestAnimationFrame(flushMeasures);
}

/**
 * Where this card is: 2 its contents are in the DOM (selected cards always are), 1 its shell is shown, 0 it is far
 * from the screen and hidden (card-virtualizer.ts).
 */
export function useVirtualPhase(nodeId: string, selected: boolean): 0 | 1 | 2 {
  const enabled = virtualizationEnabled();
  const subscribe = useCallback(
    (listener: () => void) => boardVirtualizer.subscribe(nodeId, listener),
    [nodeId],
  );
  const phase = useSyncExternalStore(
    subscribe,
    () => boardVirtualizer.phase(nodeId),
    () => 2 as const,
  );
  useEffect(() => (enabled ? boardVirtualizer.register(nodeId) : undefined), [enabled, nodeId]);
  useEffect(() => {
    // The first selected cards keep their contents wherever the camera goes (the pin puts them in the mounted set,
    // which `phase` reads); the rest of a big selection follows the camera like any card.
    if (!selected || !enabled) return;
    boardVirtualizer.pinSelected(nodeId);
    return () => boardVirtualizer.unpinSelected(nodeId);
  }, [enabled, nodeId, selected]);
  return enabled ? phase : 2;
}

/**
 * Rendered beside the card's contents while they are mounted. React Flow measured the shell (which has no
 * handles), so the first draw asks it to measure again for real, and so does a draw after the card's layout key
 * changed while it was away; the card is marked drawn when React Flow has its handles.
 */
export function DrawnSync({ nodeId, layoutKey }: { nodeId: string; layoutKey: string }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const storeApi = useStoreApi();
  useEffect(() => {
    if (!virtualizationEnabled()) return;
    const before = boardVirtualizer.drawnKeyOf(nodeId);
    boardVirtualizer.setDrawnKey(nodeId, layoutKey);
    if (before !== undefined && before !== layoutKey) boardVirtualizer.markUndrawn(nodeId);
    if (!boardVirtualizer.isDrawn(nodeId))
      queueMeasure(updateNodeInternals, storeApi as unknown as StoreLike, nodeId);
  }, [layoutKey, nodeId, updateNodeInternals, storeApi]);
  return null;
}

/**
 * The stand-in for a card whose contents are not mounted: a box of the size React Flow measured (so the wrapper,
 * the published geometry and the router see no change) wearing the card's frame and the glance face, which is
 * two elements.
 *
 * A far shell hides its React Flow wrapper (`display: none`, in the same commit that renders it). React Flow
 * ignores the zero size it then reads and keeps the card's size and handles. A shell that is shown again gets
 * its handles measured from its own DOM, so for a moment after it is shown it carries one empty marker per
 * handle at the place the card's handle was last measured: the measure it provokes reads the same boxes back.
 * (The markers are gone a moment later: every element under the board restyles when `--board-zoom` moves.)
 */
export function CardShell({
  nodeId,
  face,
  layoutKey,
  far,
}: {
  nodeId: string;
  face: ShellFace;
  layoutKey: string;
  far: boolean;
}) {
  const storeApi = useStoreApi();
  const ref = useRef<HTMLDivElement>(null);
  const glanceRef = useRef<HTMLDivElement>(null);
  // Markers while a shell has just been shown again: decided while rendering, so they are in the same commit as
  // the un-hiding (the measure it provokes comes after layout).
  const [wasFar, setWasFar] = useState(far);
  const [markers, setMarkers] = useState(false);
  if (wasFar !== far) {
    setWasFar(far);
    if (!far) setMarkers(true);
  }
  useEffect(() => {
    if (!markers || far) return;
    // They stay until React Flow has measured the shown shell (its handle boxes are a new object then), and a
    // beat longer; a shell that is never measured (hidden again at once) lets go after a while.
    const shownWith = storeApi.getState().nodeLookup.get(nodeId)?.internals.handleBounds;
    let settle = 0;
    const done = () => setMarkers(false);
    const unsubscribe = storeApi.subscribe((state) => {
      if (!settle && state.nodeLookup.get(nodeId)?.internals.handleBounds !== shownWith) {
        settle = window.setTimeout(done, MARKER_SETTLE_MS);
      }
    });
    const giveUp = window.setTimeout(done, MARKER_GIVE_UP_MS);
    return () => {
      unsubscribe();
      window.clearTimeout(settle);
      window.clearTimeout(giveUp);
    };
  }, [markers, far, storeApi, nodeId]);
  useEffect(() => {
    // Its layout changed while it was away (an undo far off, a solve that added a forced row): drawn again in the
    // background pass, which gives React Flow the new box and handles.
    const before = boardVirtualizer.drawnKeyOf(nodeId);
    if (before !== undefined && before !== layoutKey) {
      boardVirtualizer.setDrawnKey(nodeId, undefined);
      boardVirtualizer.markUndrawn(nodeId);
    }
  }, [layoutKey, nodeId]);
  useEffect(() => {
    // A ring's outline pulses off the prompts' clock, on a shell as on its card.
    if (face.loop) syncPromptPhase();
  }, [face.loop]);
  useLayoutEffect(() => {
    const wrapper = ref.current?.closest(".react-flow__node");
    if (!wrapper) return;
    if (far) wrapper.setAttribute(FAR_ATTRIBUTE, "");
    else {
      wrapper.removeAttribute(FAR_ATTRIBUTE);
      // Shown at the glance step: it takes the zoom variable now, not at the next zoom step.
      applyZoomTo(wrapper as HTMLElement);
    }
    return () => wrapper.removeAttribute(FAR_ATTRIBUTE);
  }, [far]);
  const glance = glanceFace(face.art ? `url(${face.art})` : undefined, face.bar);
  const internal = storeApi.getState().nodeLookup.get(nodeId);
  const measured = internal?.measured;
  const handles = markers && !far ? internal?.internals.handleBounds : undefined;
  const style: CSSProperties = {
    width: measured?.width ?? face.fallbackWidth,
    height: measured?.height ?? face.fallbackHeight,
  };
  const marker = (
    type: "source" | "target",
    h: {
      id?: string | null;
      position: string;
      x: number;
      y: number;
      width: number;
      height: number;
    },
  ) => (
    <div
      key={`${type}:${h.id ?? ""}`}
      className={type}
      data-vstub=""
      data-handleid={h.id ?? undefined}
      data-handlepos={h.position}
      style={{ position: "absolute", left: h.x, top: h.y, width: h.width, height: h.height }}
    />
  );
  return (
    <div
      ref={ref}
      className="cc-card"
      data-node-glance-root=""
      data-shell=""
      data-selected={face.selected ? "" : undefined}
      data-cannot-run={face.cannotRun ? "" : undefined}
      data-unset={face.unset ? "" : undefined}
      data-tone={face.tone}
      data-loop={face.loop}
      style={style}
    >
      <div
        ref={glanceRef}
        className="cc-glance"
        data-node-detail="glance"
        data-count={face.count}
        data-bar={glance["data-bar"]}
        data-tone={glance["data-tone"]}
        aria-hidden
        style={glance.style}
      >
        {glance.text}
        <MotionNumberAttribute
          target={glanceRef}
          attribute="data-count"
          value={face.countValue}
          format={(value) => `×${formatSolvedMachines(value)}`}
        />
      </div>
      {handles?.source?.map((h) => marker("source", h))}
      {handles?.target?.map((h) => marker("target", h))}
    </div>
  );
}
