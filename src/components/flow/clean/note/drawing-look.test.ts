import { describe, expect, it } from "vitest";
import type { FactoryAnnotation } from "@/lib/model/types";
import {
  DRAWING,
  arrowEnds,
  arrowFromEnds,
  arrowHead,
  arrowStyle,
  boxStyleWith,
  drawingLook,
  scalePoints,
  surfaceFill,
  withAlpha,
} from "./drawing-look";
import { useFactoryStore } from "@/store/factory-store";

const base = { id: "a", position: { x: 0, y: 0 }, size: { width: 100, height: 100 } };

describe("drawing look", () => {
  it("is the classic default: solid border and a faint tint in the colour tag", () => {
    const look = drawingLook({ ...base, kind: "box", colorTag: "azure" } as FactoryAnnotation);
    expect(look.border).toBe("solid");
    expect(look.borderColor).toBe("#3b82f6");
    expect(surfaceFill(look)).toBe("#3b82f614");
  });

  it("reads legacy fills: a mark name is a tint wearing it, paper is solid", () => {
    const hatch = drawingLook({ ...base, kind: "zone", style: { fill: "hatch" } } as FactoryAnnotation);
    expect(hatch.surface).toBe("tint");
    expect(hatch.marks).toBe("hatch");
    const paper = drawingLook({ ...base, kind: "box", style: { fill: "paper" } } as FactoryAnnotation);
    expect(surfaceFill(paper)).toBe("#fed83d47");
    expect(surfaceFill(drawingLook({ ...base, kind: "box", style: { fill: "none" } } as FactoryAnnotation))).toBeUndefined();
  });

  it("border and fill colours fall back to the tag", () => {
    const look = drawingLook({
      ...base,
      kind: "box",
      colorTag: "lime",
      style: { borderColor: "red" },
    } as FactoryAnnotation);
    expect(look.borderColor).toBe("#b02e26");
    expect(look.fillColor).toBe("#80c71f");
  });

  it("sizes are the mod's times the card scale", () => {
    expect(DRAWING.line).toBe(2);
    expect(withAlpha("#ffffff", 20)).toBe("#ffffff14");
  });

  it("an arrow goes tail to head across its box and the head points along it", () => {
    expect(arrowEnds(undefined, 80, 40)).toEqual({ from: { x: 0, y: 0 }, to: { x: 80, y: 40 } });
    expect(arrowEnds("up-left", 80, 40)).toEqual({ from: { x: 80, y: 40 }, to: { x: 0, y: 0 } });
    const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(head[0]).toEqual({ x: 100, y: 0 });
    expect(head[1].x).toBeCloseTo(100 - DRAWING.headLength);
    expect(head[1].y).toBeCloseTo(DRAWING.headWidth / 2);
  });

  it("an arrow's two ends become its box and direction, and back", () => {
    const shape = arrowFromEnds({ x: 100, y: 80 }, { x: 40, y: 20 });
    expect(shape).toEqual({ position: { x: 40, y: 20 }, size: { width: 60, height: 60 }, arrowDirection: "up-left" });
    const ends = arrowEnds(shape.arrowDirection, shape.size.width, shape.size.height);
    expect(ends).toEqual({ from: { x: 60, y: 60 }, to: { x: 0, y: 0 } });
    // dead level to the left keeps its side
    const level = arrowFromEnds({ x: 100, y: 40 }, { x: 20, y: 40 });
    expect(level.size.height).toBe(0);
    expect(arrowEnds(level.arrowDirection, 80, 0)).toEqual({ from: { x: 80, y: 0 }, to: { x: 0, y: 0 } });
  });

  it("an arrow is two mod px thick with one head unless it says otherwise", () => {
    expect(arrowStyle({})).toEqual({ width: 2, both: false });
    expect(arrowStyle({ arrowWidth: 4, arrowHeads: "both" })).toEqual({ width: 4, both: true });
  });

  it("choosing a fill keeps a legacy mark; marks and fill are separate choices", () => {
    expect(boxStyleWith({ style: { fill: "hatch" } }, { fill: "solid" })).toEqual({ fill: "solid", marks: "hatch" });
    expect(boxStyleWith({}, { marks: "grid", border: "dashed" })).toEqual({ marks: "grid", border: "dashed" });
    expect(boxStyleWith({ style: { fill: "paper" } }, { border: "dashed" })).toEqual({ fill: "solid", border: "dashed" });
  });

  it("the store lets an arrow run level (an axis of 0) and snaps the rest", () => {
    const store = useFactoryStore.getState();
    store.addAnnotation({ kind: "arrow", position: { x: 13, y: 7 }, size: { width: 157, height: 0 }, arrowDirection: "down-right" });
    const added = useFactoryStore.getState().project.annotations!.at(-1)!;
    expect(added.size).toEqual({ width: 160, height: 0 });
    store.addAnnotation({ kind: "box", position: { x: 0, y: 0 }, size: { width: 5, height: 0 } });
    expect(useFactoryStore.getState().project.annotations!.at(-1)!.size).toEqual({ width: 20, height: 20 });
  });

  it("a zone's points scale with its box", () => {
    expect(scalePoints([{ x: 10, y: 20 }], { width: 100, height: 100 }, { width: 200, height: 50 })).toEqual([
      { x: 20, y: 10 },
    ]);
  });
});
