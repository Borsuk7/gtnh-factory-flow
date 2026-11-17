/**
 * WHICH CARDS HAVE THEIR CONTENTS IN THE DOM.
 *
 * Every card of a plan keeps its React Flow node wrapper and a fixed-size shell, but the card's contents (the
 * clean card is 48-65 elements) are mounted only for the cards on or near the screen: at 1,000 cards that is 190k
 * elements down to the 15k the performance budget allows (virtual cards in src/components/flow/AGENTS.md).
 *
 * This file is the pure part: a spatial index over the published card boxes (flow space, never the DOM), the set
 * of mounted cards, and the rules for who is in it.
 *
 * - IN: a card whose box meets the camera's rectangle grown by `margin` of its size on every side, the nearest
 *   `cap` of them, a few at a time (`batch` a step) so a zoom out does not mount a hundred cards in one frame.
 * - OUT: the larger `keepMargin` rectangle can use spare camera slots. A card outside it leaves after `releaseMs`. The gap between the
 *   two rectangles and the delay are the hysteresis: a camera parked on a boundary never flickers a card.
 * - PINNED: hovered, focused, selected, being refreshed after a change: in whatever the camera says.
 * - HELD: everything, for the image export and the screenshot panel (they photograph the whole plan).
 * - A card never drawn (a plan just opened, a card whose layout changed while it was away) is queued to be drawn
 *   once behind the near ones, the background pass: React Flow has measured its shell at the estimated size, and
 *   its real size and handles come from that one draw. A plan of a thousand cards opens as shells and fills in over
 *   a second or two, nearest the camera first, a few cards a frame, with no frame over a few milliseconds.
 * - Zoomed out to the glance step nothing is in (the shell paints the glance face) except the background pass.
 * - A card that has been drawn and is far from the screen (past `farMargin`) is FAR: its shell is hidden with
 *   `display: none`, so the browser has nothing of it to style, hit-test or layerize (a thousand positioned
 *   wrappers cost 20 ms a frame to the compositor even when nothing in them paints). React Flow ignores the
 *   zero-sized measure of a hidden card and keeps the card's size and handles. Three phases, then: 0 far,
 *   1 a shell on or near the screen, 2 the card.
 *
 * It never reads the DOM and never schedules: `step(now)` does one round of work and says whether another is
 * wanted. The controller (VirtualizationController.tsx) calls it from requestAnimationFrame.
 */

export interface VRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VirtualizerConfig {
  /** The most cards mounted because of the camera (pins, holds and the background pass come on top). */
  cap: number;
  /** How far past the screen a card still counts as near, as a share of the screen's own size. */
  margin: number;
  /** How far past it a mounted card is kept; larger than `margin`. */
  keepMargin: number;
  /** How far past the screen a drawn card's shell is still shown (not hidden as far). */
  farMargin: number;
  /** How long a card must stay out of the keep rectangle before it goes. */
  releaseMs: number;
  /** The same at the glance step. */
  glanceReleaseMs: number;
  /** The most cards one step mounts for the camera. */
  batch: number;
  /** The most cards one step mounts for the background pass (a card costs about 8 ms to draw the first time). */
  backgroundBatch: number;
  /** The background pass waits this long after the camera last moved. */
  idleMs: number;
  /** The most selected cards pinned in the DOM beyond the camera's own (a selection can be the whole plan). */
  maxSelectedPins: number;
  /** A card is not released sooner than this after it mounted: React Flow measures it in the meantime. */
  minMountMs: number;
}

export const VIRTUAL_DEFAULTS: VirtualizerConfig = {
  cap: 150,
  margin: 0.5,
  keepMargin: 0.9,
  farMargin: 1.1,
  releaseMs: 300,
  glanceReleaseMs: 0,
  batch: 8,
  backgroundBatch: 6,
  idleMs: 100,
  maxSelectedPins: 60,
  minMountMs: 120,
};

/** The coarse index's cell, in flow px (the mod's BoardCanvas.getChildren uses the same 512). */
export const VIRTUAL_CELL = 512;

function cellKey(cx: number, cy: number): number {
  // Boards live within a few hundred thousand px of the origin; the pair is packed into one integer key.
  return (cx + 32768) * 65536 + (cy + 32768);
}

export function grow(rect: VRect, share: number): VRect {
  const dx = rect.w * share;
  const dy = rect.h * share;
  return { x: rect.x - dx, y: rect.y - dy, w: rect.w + 2 * dx, h: rect.h + 2 * dy };
}

export function meets(a: VRect, b: VRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export class CardVirtualizer {
  readonly config: VirtualizerConfig;
  private geometry = new Map<string, VRect>();
  private cells = new Map<number, string[]>();
  /** Cards whose contents have been drawn since their layout last changed (their size and handles are real). */
  private drawn = new Set<string>();
  /** The layout key each card had when its contents were last drawn (virtual/use-card-face.ts). */
  private keys = new Map<string, string>();
  /** The cards that mount their contents by this (drawers, notes and special cards do not). */
  private members = new Set<string>();
  private view: VRect | undefined;
  private boardKey: string | undefined;
  private glance = false;
  private mountedSet = new Set<string>();
  private mountedAt = new Map<string, number>();
  /** The cards whose box meets the camera grown by `farMargin`. */
  private visibleSet = new Set<string>();
  private visibleKnown = false;
  private pins = new Map<string, number>();
  private holds = 0;
  private outSince = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  /** Bumped on every change of who is mounted; for tests and for the dev readout. */
  version = 0;
  private dirty = true;
  /** Set by the controller: called when geometry or the camera changed and a step is wanted. */
  wake: (() => void) | undefined;

  constructor(config: Partial<VirtualizerConfig> = {}) {
    this.config = { ...VIRTUAL_DEFAULTS, ...config };
  }

  /** The published boxes of every measured card, in flow space. */
  setGeometry(boxes: Iterable<readonly [string, VRect]>): void {
    this.geometry.clear();
    this.cells.clear();
    for (const [id, rect] of boxes) {
      if (!(rect.w > 0 && rect.h > 0)) continue;
      this.geometry.set(id, rect);
      const x0 = Math.floor(rect.x / VIRTUAL_CELL);
      const x1 = Math.floor((rect.x + rect.w) / VIRTUAL_CELL);
      const y0 = Math.floor(rect.y / VIRTUAL_CELL);
      const y1 = Math.floor((rect.y + rect.h) / VIRTUAL_CELL);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
          const key = cellKey(cx, cy);
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(id);
          else this.cells.set(key, [id]);
        }
      }
    }
    // A card removed from the plan is no longer anyone's to mount.
    for (const id of [...this.mountedSet]) {
      if (!this.geometry.has(id)) {
        this.mountedSet.delete(id);
        this.mountedAt.delete(id);
      }
    }
    for (const id of [...this.drawn]) if (!this.geometry.has(id)) this.drawn.delete(id);
    for (const id of [...this.keys.keys()]) if (!this.geometry.has(id)) this.keys.delete(id);
    this.dirty = true;
    this.wake?.();
  }

  boxOf(id: string): VRect | undefined {
    return this.geometry.get(id);
  }

  /** The camera: the rectangle of flow space the screen shows, and whether the board is at the glance step. */
  private movedAt = Number.NEGATIVE_INFINITY;

  setView(view: VRect, glance: boolean): void {
    const same =
      this.view &&
      this.glance === glance &&
      this.view.x === view.x &&
      this.view.y === view.y &&
      this.view.w === view.w &&
      this.view.h === view.h;
    if (same) return;
    this.view = view;
    this.glance = glance;
    this.movedAt = performance.now();
    this.dirty = true;
    this.wake?.();
  }

  viewRect(): VRect | undefined {
    return this.view;
  }

  isGlance(): boolean {
    return this.glance;
  }

  /** The card's contents were drawn: its size and handles are measured for real. */
  markDrawn(id: string): void {
    const before = this.phase(id);
    this.drawn.add(id);
    if (this.phase(id) !== before) this.notify(id);
  }

  /** The card's layout changed while it was away: it is drawn once more in the background pass. */
  markUndrawn(id: string): void {
    const before = this.phase(id);
    if (this.drawn.delete(id)) {
      if (this.phase(id) !== before) this.notify(id);
      this.dirty = true;
      this.wake?.();
    }
  }

  /** A different plan is on the board: nothing of the last one is known. */
  useBoard(key: string | undefined): void {
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.geometry.clear();
    this.cells.clear();
    this.drawn.clear();
    this.visibleSet = new Set();
    this.visibleKnown = false;
    this.keys.clear();
    this.mountedSet.clear();
    this.mountedAt.clear();
    this.outSince.clear();
    this.pins.clear();
    // No notify: this runs while the board renders, and the cards of the old plan are on their way out.
  }

  /** The layout key of the card's last draw. */
  drawnKeyOf(id: string): string | undefined {
    return this.keys.get(id);
  }

  setDrawnKey(id: string, key: string | undefined): void {
    if (key === undefined) this.keys.delete(id);
    else this.keys.set(id, key);
  }

  /** The ids whose box meets the camera grown by `farMargin` (empty before the first camera). */
  visibleIds(): ReadonlySet<string> {
    return this.visibleSet;
  }

  /** Whether the camera is known and every card's visibility has been worked out. */
  hasView(): boolean {
    return this.visibleKnown;
  }

  /** Every card with a published box. */
  geometryIds(): IterableIterator<string> {
    return this.geometry.keys();
  }

  isMember(id: string): boolean {
    return this.members.has(id);
  }

  isDrawn(id: string): boolean {
    return this.drawn.has(id);
  }

  /** A card that is virtualised says so, so the background pass knows which cards to draw. */
  register(id: string): () => void {
    this.members.add(id);
    this.dirty = true;
    this.wake?.();
    return () => {
      this.members.delete(id);
    };
  }

  undrawnCount(): number {
    let count = 0;
    for (const id of this.members) if (this.geometry.has(id) && !this.drawn.has(id)) count += 1;
    return count;
  }

  /** Selected cards that keep their contents whatever the camera says: a select-all of a thousand does not. */
  private selectedPins = new Set<string>();

  /** Pins a selected card unless too many are pinned already; says whether it is. */
  pinSelected(id: string): boolean {
    if (!this.selectedPins.has(id)) {
      if (this.selectedPins.size >= this.config.maxSelectedPins) return false;
      this.selectedPins.add(id);
      this.pin(id);
    }
    return true;
  }

  unpinSelected(id: string): void {
    if (this.selectedPins.delete(id)) this.unpin(id);
  }

  pin(id: string): void {
    const count = this.pins.get(id) ?? 0;
    this.pins.set(id, count + 1);
    // Pinned means mounted by the ordinary set too, so that when the pin ends the camera's rules decide
    // whether it stays, and nothing changes under a card that is being used.
    if (!this.mountedSet.has(id)) {
      const was = this.hasContents(id);
      this.mountedSet.add(id);
      this.mountedAt.set(id, 0);
      if (!was) this.notify(id);
    }
  }

  unpin(id: string): void {
    const count = this.pins.get(id) ?? 0;
    if (count <= 1) {
      this.pins.delete(id);
      // It stays mounted until a step decides it is out: no flash on a pin that ends.
      this.outSince.delete(id);
      this.dirty = true;
      this.wake?.();
    } else {
      this.pins.set(id, count - 1);
    }
  }

  /** Everything mounted until the returned function is called. Counted, so two exports may overlap. */
  hold(): () => void {
    this.holds += 1;
    if (this.holds === 1) this.notifyAll();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.holds === 0) {
        this.dirty = true;
        this.notifyAll();
        this.wake?.();
      }
    };
  }

  holding(): boolean {
    return this.holds > 0;
  }

  hasContents(id: string): boolean {
    return this.holds > 0 || this.mountedSet.has(id);
  }

  /** 2 the card is in the DOM, 1 its shell is shown, 0 it is far from the screen and hidden. */
  phase(id: string): 0 | 1 | 2 {
    if (this.hasContents(id)) return 2;
    // Not hidden before it has been drawn (its size and handles are not known yet) or before there is a camera.
    if (!this.view || !this.drawn.has(id) || this.visibleSet.has(id)) return 1;
    return 0;
  }

  mountedCount(): number {
    return this.mountedSet.size;
  }

  mountedIds(): string[] {
    return [...this.mountedSet];
  }

  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0 && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  private notify(id: string): void {
    this.version += 1;
    const set = this.listeners.get(id);
    if (set) for (const listener of [...set]) listener();
  }

  private notifyAll(): void {
    this.version += 1;
    for (const set of [...this.listeners.values()]) for (const listener of [...set]) listener();
  }

  /** The ids the camera wants mounted, nearest the middle of the screen first, at most `cap`. */
  private wanted(): string[] {
    const view = this.view;
    if (!view || this.glance) return [];
    const reach = grow(view, this.config.margin);
    const x0 = Math.floor(reach.x / VIRTUAL_CELL);
    const x1 = Math.floor((reach.x + reach.w) / VIRTUAL_CELL);
    const y0 = Math.floor(reach.y / VIRTUAL_CELL);
    const y1 = Math.floor((reach.y + reach.h) / VIRTUAL_CELL);
    const seen = new Set<string>();
    const found: Array<[number, string]> = [];
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const consider = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const rect = this.geometry.get(id)!;
      if (!meets(rect, reach)) return;
      found.push([Math.hypot(rect.x + rect.w / 2 - cx, rect.y + rect.h / 2 - cy), id]);
    };
    // A camera zoomed far out can span more cells than there are cards: walk the cards instead.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.geometry.size) {
      for (const id of this.geometry.keys()) consider(id);
    } else {
      for (let ix = x0; ix <= x1; ix += 1) {
        for (let iy = y0; iy <= y1; iy += 1) {
          const bucket = this.cells.get(cellKey(ix, iy));
          if (bucket) for (const id of bucket) consider(id);
        }
      }
    }
    found.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    if (found.length > this.config.cap) found.length = this.config.cap;
    return found.map((entry) => entry[1]);
  }

  /** The ids whose box meets the camera grown by `farMargin` (the glance step shows its faces the same way). */
  private visibleNow(): Set<string> {
    return this.idsMeeting(this.config.farMargin);
  }

  /** The ids whose box meets the camera rectangle grown by `margin` of its size. */
  idsMeeting(margin: number): Set<string> {
    const out = new Set<string>();
    const view = this.view;
    if (!view) return out;
    const reach = grow(view, margin);
    const x0 = Math.floor(reach.x / VIRTUAL_CELL);
    const x1 = Math.floor((reach.x + reach.w) / VIRTUAL_CELL);
    const y0 = Math.floor(reach.y / VIRTUAL_CELL);
    const y1 = Math.floor((reach.y + reach.h) / VIRTUAL_CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.geometry.size) {
      for (const [id, rect] of this.geometry) if (meets(rect, reach)) out.add(id);
    } else {
      for (let ix = x0; ix <= x1; ix += 1) {
        for (let iy = y0; iy <= y1; iy += 1) {
          const bucket = this.cells.get(cellKey(ix, iy));
          if (!bucket) continue;
          for (const id of bucket) if (!out.has(id) && meets(this.geometry.get(id)!, reach)) out.add(id);
        }
      }
    }
    return out;
  }

  /** Cards never drawn, nearest the middle of the screen first (the whole board when there is no camera yet). */
  private undrawn(): string[] {
    const view = this.view;
    const cx = view ? view.x + view.w / 2 : 0;
    const cy = view ? view.y + view.h / 2 : 0;
    const found: Array<[number, string]> = [];
    for (const id of this.members) {
      const rect = this.geometry.get(id);
      if (!rect || this.drawn.has(id) || this.mountedSet.has(id)) continue;
      found.push([Math.hypot(rect.x + rect.w / 2 - cx, rect.y + rect.h / 2 - cy), id]);
    }
    found.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    return found.map((entry) => entry[1]);
  }

  /**
   * One round: let go of the cards that left, mount the next `batch` that came near (then the next undrawn
   * ones, if the batch has room). Returns whether another round is wanted.
   */
  step(now: number): boolean {
    if (!this.view) return false;
    const wanted = this.wanted();
    const wantedSet = new Set(wanted);
    let again = false;

    // Which shells are shown: the others are hidden. Only a change of phase of an unmounted card is news.
    let visible = this.visibleNow();
    const previous = this.visibleSet;
    const hadView = this.visibleKnown;
    // The same object while nothing changed, so a reader can compare by identity.
    if (hadView && visible.size === previous.size && [...visible].every((id) => previous.has(id))) visible = previous;
    this.visibleSet = visible;
    this.visibleKnown = true;
    const shellOnly = (id: string) => !this.mountedSet.has(id) && this.drawn.has(id);
    if (hadView) {
      for (const id of visible) if (!previous.has(id) && shellOnly(id)) this.notify(id);
      for (const id of previous) if (!visible.has(id) && shellOnly(id)) this.notify(id);
    } else {
      // The first camera: every shell was shown, now the far ones are hidden.
      for (const id of this.geometry.keys()) if (!visible.has(id) && shellOnly(id)) this.notify(id);
    }

    // Release first, so a card that left frees its place before one that arrived takes it.
    const keep = this.glance ? undefined : grow(this.view, this.config.keepMargin);
    let spareSeats = this.config.cap - wanted.length;
    let measuring = 0;
    for (const id of [...this.mountedSet]) {
      const rect = this.geometry.get(id);
      if (wantedSet.has(id) || this.pins.has(id) || this.holds > 0) {
        this.outSince.delete(id);
        continue;
      }
      const inKeep = keep !== undefined && rect !== undefined && meets(rect, keep);
      if (inKeep && this.drawn.has(id) && spareSeats > 0) {
        spareSeats -= 1;
        this.outSince.delete(id);
        continue;
      }
      // Not before the card has been drawn and measured (or, if nothing ever draws it, a couple of seconds).
      const age = now - (this.mountedAt.get(id) ?? Number.NEGATIVE_INFINITY);
      if (age < this.config.minMountMs || (!this.drawn.has(id) && age < 2000)) {
        measuring += 1;
        again = true;
        continue;
      }
      // At the glance step the contents go at once: the shell already shows the face, and the board restyles
      // once for the flip instead of once more for every element of cards about to be removed.
      const delay = this.glance ? this.config.glanceReleaseMs : inKeep ? 0 : this.config.releaseMs;
      const since = this.outSince.get(id) ?? (delay === 0 ? now : undefined);
      if (since === undefined) {
        this.outSince.set(id, now);
        again = true;
        continue;
      }
      if (now - since >= delay) {
        this.outSince.delete(id);
        this.mountedSet.delete(id);
        this.mountedAt.delete(id);
        this.notify(id);
      } else {
        again = true;
      }
    }

    // Arrivals: the near ones first, then the background pass; a batch a step.
    let mountedNow = 0;
    const mount = (id: string) => {
      this.mountedSet.add(id);
      this.mountedAt.set(id, now);
      this.outSince.delete(id);
      mountedNow += 1;
      this.notify(id);
    };
    const queue = wanted.filter((id) => !this.mountedSet.has(id));
    for (const id of queue) {
      if (mountedNow >= this.config.batch) break;
      mount(id);
    }
    if (mountedNow < queue.length) again = true;
    // The background pass keeps out of the way of a moving camera.
    if (this.undrawnCount() > 0) {
      again = true;
      if (this.holds === 0 && measuring < this.config.backgroundBatch && now - this.movedAt >= this.config.idleMs) {
        for (const id of this.undrawn()) {
          if (measuring >= this.config.backgroundBatch) break;
          mount(id);
          measuring += 1;
        }
      }
    }

    this.dirty = again;
    return again;
  }

  /** True when a view or box change has not been stepped yet. */
  needsStep(): boolean {
    return this.dirty;
  }

  /** The mounted set computed from scratch with no batching or delay: what a settled camera converges on. */
  settle(): void {
    if (!this.view) return;
    let now = 0;
    for (let guard = 0; guard < 512; guard += 1) {
      now += 10_000;
      if (!this.step(now)) break;
    }
  }
}

/** The one board's virtualizer. The app shows one board at a time; a tab switch re-feeds the geometry. */
export const boardVirtualizer = new CardVirtualizer();

const DISABLE_KEY = "gtnh-factory-flow.no-virtual";

/** `localStorage["gtnh-factory-flow.no-virtual"] = "1"` turns the shell off (A/B, bugs). */
export function virtualizationEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISABLE_KEY) !== "1";
  } catch {
    return true;
  }
}

