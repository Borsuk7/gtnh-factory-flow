import { describe, expect, it } from "vitest";
import { CardVirtualizer, grow, meets, type VRect } from "./card-virtualizer";

/** A grid of 320 x 240 cards, `cols` x `rows`, one every 640 x 440. */
function grid(cols: number, rows: number): Array<readonly [string, VRect]> {
  const out: Array<readonly [string, VRect]> = [];
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) out.push([`n${c}_${r}`, { x: c * 640, y: r * 440, w: 320, h: 240 }] as const);
  }
  return out;
}

function board(cols: number, rows: number, config = {}) {
  const v = new CardVirtualizer({ idleMs: 0, ...config });
  v.setGeometry(grid(cols, rows));
  for (const [id] of grid(cols, rows)) {
    v.register(id);
    v.markDrawn(id);
  }
  return v;
}

describe("geometry helpers", () => {
  it("grows a rectangle by a share of its size on every side", () => {
    expect(grow({ x: 0, y: 0, w: 100, h: 50 }, 0.5)).toEqual({ x: -50, y: -25, w: 200, h: 100 });
  });
  it("meets only when the rectangles overlap", () => {
    expect(meets({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 })).toBe(true);
    expect(meets({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe("CardVirtualizer", () => {
  it("mounts the cards on and near the screen and no others", () => {
    const v = board(30, 30);
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    const mounted = v.mountedIds();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(60);
    expect(v.hasContents("n0_0")).toBe(true);
    expect(v.hasContents("n29_29")).toBe(false);
  });

  it("never mounts more than the cap, nearest the middle first", () => {
    const v = board(60, 60, { cap: 25 });
    v.setView({ x: 0, y: 0, w: 38_400, h: 26_400 }, false);
    v.settle();
    expect(v.mountedCount()).toBe(25);
    // The middle of that screen is (19200, 13200): the card nearest it is in, a corner card is not.
    expect(v.hasContents("n30_30")).toBe(true);
    expect(v.hasContents("n0_0")).toBe(false);
  });

  it("mounts a batch a step, so a big zoom out does not mount a hundred cards in one frame", () => {
    const v = board(30, 30, { batch: 8 });
    v.setView({ x: 0, y: 0, w: 8000, h: 5000 }, false);
    const more = v.step(0);
    expect(more).toBe(true);
    expect(v.mountedCount()).toBe(8);
    v.step(1000);
    expect(v.mountedCount()).toBe(16);
  });

  it("keeps a card that left until it is outside the keep rectangle for the release time", () => {
    const v = board(30, 30);
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    expect(v.hasContents("n0_0")).toBe(true);
    // Pan so that n0_0 is outside the mount rectangle but inside the keep one: it stays.
    v.setView({ x: 1500, y: 0, w: 1920, h: 1080 }, false);
    v.step(100_000);
    expect(v.hasContents("n0_0")).toBe(true);
    // Far away: it goes only after the release time.
    v.setView({ x: 15000, y: 8000, w: 1920, h: 1080 }, false);
    v.step(200_000);
    expect(v.hasContents("n0_0")).toBe(true);
    v.step(200_000 + 400);
    expect(v.hasContents("n0_0")).toBe(false);
  });

  it("does not release a card before it has been drawn and measured", () => {
    const v = new CardVirtualizer({ idleMs: 100_000 });
    v.setGeometry(grid(10, 10));
    v.register("n0_0");
    v.setView({ x: 0, y: 0, w: 800, h: 600 }, false);
    v.step(0);
    expect(v.hasContents("n0_0")).toBe(true);
    v.setView({ x: 5000, y: 3000, w: 800, h: 600 }, false);
    v.step(1000);
    v.step(1500);
    expect(v.hasContents("n0_0")).toBe(true);
    v.markDrawn("n0_0");
    v.step(1600);
    v.step(2000);
    expect(v.hasContents("n0_0")).toBe(false);
  });

  it("shows nothing mounted at the glance step, at once", () => {
    const v = board(10, 10);
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    expect(v.mountedCount()).toBeGreaterThan(0);
    v.setView({ x: 0, y: 0, w: 6000, h: 4000 }, true);
    v.step(10_000_000);
    expect(v.mountedCount()).toBe(0);
  });

  it("keeps pinned cards mounted wherever the camera is, and lets the camera decide after the pin", () => {
    const v = board(30, 30);
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    v.pin("n29_29");
    expect(v.hasContents("n29_29")).toBe(true);
    v.step(500_000);
    expect(v.hasContents("n29_29")).toBe(true);
    v.unpin("n29_29");
    v.step(600_000);
    v.step(600_500);
    expect(v.hasContents("n29_29")).toBe(false);
  });

  it("pins the first selected cards and lets the rest of a big selection follow the camera", () => {
    const v = board(30, 30, { maxSelectedPins: 5 });
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    const far = Array.from({ length: 12 }, (_, i) => `n29_${i}`);
    const pinned = far.map((id) => v.pinSelected(id));
    expect(pinned.filter(Boolean)).toHaveLength(5);
    for (const id of far.slice(0, 5)) expect(v.hasContents(id)).toBe(true);
    for (const id of far.slice(5)) expect(v.hasContents(id)).toBe(false);
    v.unpinSelected("n29_0");
    expect(v.pinSelected("n29_5")).toBe(true);
  });

  it("notifies a card when its phase changes and no other", () => {
    const v = board(30, 30);
    const seen: string[] = [];
    v.subscribe("n0_0", () => seen.push("near"));
    v.subscribe("n29_29", () => seen.push("far"));
    v.subscribe("n6_0", () => seen.push("between"));
    expect(v.phase("n0_0")).toBe(1);
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    // The near card is mounted (phase 2), the far one hidden (phase 0), the one past the mount margin but inside
    // the far margin stays a shown shell and hears nothing.
    expect(v.phase("n0_0")).toBe(2);
    expect(v.phase("n29_29")).toBe(0);
    expect(v.phase("n6_0")).toBe(1);
    expect(seen).not.toContain("between");
    expect(seen.filter((entry) => entry === "near")).toHaveLength(1);
    expect(seen.filter((entry) => entry === "far")).toHaveLength(1);
  });

  it("shows a drawn card's shell until it is past the far margin, and any card never drawn", () => {
    const v = new CardVirtualizer({ idleMs: 100_000 });
    v.setGeometry(grid(30, 1));
    v.register("n29_0");
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.step(0);
    expect(v.phase("n29_0")).toBe(1);
    v.markDrawn("n29_0");
    expect(v.phase("n29_0")).toBe(0);
    v.setView({ x: 18_000, y: 0, w: 1920, h: 1080 }, false);
    v.step(1000);
    expect(v.phase("n29_0")).toBe(2);
  });

  it("mounts everything while held, then goes back", () => {
    const v = board(30, 30);
    v.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
    v.settle();
    const release = v.hold();
    expect(v.hasContents("n29_29")).toBe(true);
    expect(v.holding()).toBe(true);
    const second = v.hold();
    release();
    expect(v.hasContents("n29_29")).toBe(true);
    second();
    expect(v.hasContents("n29_29")).toBe(false);
  });

  it("draws cards never drawn in the background, a few a step, only while the camera is still", () => {
    const v = new CardVirtualizer({ backgroundBatch: 5, idleMs: 100 });
    v.setGeometry(grid(10, 10));
    for (const [id] of grid(10, 10)) v.register(id);
    v.setView({ x: 0, y: 0, w: 800, h: 600 }, false);
    const t0 = performance.now();
    // Moving: only the near cards come in.
    v.step(t0 + 1);
    const near = v.mountedCount();
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(10);
    // Still: the pass adds five more a step, nearest first.
    v.step(t0 + 500);
    expect(v.mountedCount()).toBe(near + 5);
    expect(v.undrawnCount()).toBe(100);
    for (const id of v.mountedIds()) v.markDrawn(id);
    expect(v.undrawnCount()).toBe(100 - (near + 5));
  });

  it("draws a card again once its layout is marked changed", () => {
    const v = board(5, 5);
    expect(v.undrawnCount()).toBe(0);
    v.markUndrawn("n3_3");
    expect(v.undrawnCount()).toBe(1);
    expect(v.isDrawn("n3_3")).toBe(false);
  });

  it("returns to the camera budget after measuring a crowded board", () => {
    const boxes = grid(20, 20);
    const virtualizer = new CardVirtualizer({ idleMs: 0 });
    virtualizer.setGeometry(boxes);
    for (const [id] of boxes) virtualizer.register(id);
    virtualizer.setView({ x: 1500, y: 800, w: 4000, h: 2500 }, false);
    let now = performance.now();
    for (let step = 0; step < 200; step += 1) {
      virtualizer.step(now += 100);
      for (const id of virtualizer.mountedIds()) virtualizer.markDrawn(id);
    }
    expect(virtualizer.undrawnCount()).toBe(0);
    expect(virtualizer.mountedCount()).toBeLessThanOrEqual(virtualizer.config.cap);
  });

  it("forgets a card that left the plan and a whole board that was replaced", () => {
    const v = board(5, 5);
    v.setView({ x: 0, y: 0, w: 4000, h: 3000 }, false);
    v.settle();
    v.setGeometry(grid(3, 3));
    expect(v.hasContents("n4_4")).toBe(false);
    v.useBoard("a");
    v.setGeometry(grid(5, 5));
    v.useBoard("b");
    expect(v.boxOf("n0_0")).toBeUndefined();
    expect(v.mountedCount()).toBe(0);
  });
});
