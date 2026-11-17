import { expect, it } from "vitest";
import { isDockedOnCard, previewDraggedWire } from "./wire-drag-preview";

const source = { left: 0, right: 320, top: 180, bottom: 340 };
const target = { left: 520, right: 840, top: 0, bottom: 160 };

it("attaches to the live rims when a previously solved dock is left behind", () => {
  expect(isDockedOnCard({ x: 320, y: 80 }, source)).toBe(false);
  expect(isDockedOnCard({ x: 300, y: 220 }, source)).toBe(false);
  const points = previewDraggedWire(source, target, false);
  expect(isDockedOnCard(points[0], source)).toBe(true);
  expect(isDockedOnCard(points.at(-1), target)).toBe(true);
});

it("leaves pinned waypoints in board space while the endpoints move", () => {
  const waypoints = [{ x: 380, y: 400 }, { x: 480, y: 100 }];
  const points = previewDraggedWire(source, target, false, waypoints);
  expect(points.slice(1, -1)).toEqual(waypoints);
  expect(isDockedOnCard(points[0], source)).toBe(true);
  expect(isDockedOnCard(points.at(-1), target)).toBe(true);
});

it("keeps a loop outside a moving card and returns to a different dock", () => {
  const points = previewDraggedWire(source, source, true);
  expect(isDockedOnCard(points[0], source)).toBe(true);
  expect(isDockedOnCard(points.at(-1), source)).toBe(true);
  expect(points[0]).not.toEqual(points.at(-1));
  expect(points.slice(1, -1).every(({ x, y }) => x > source.right || y < source.top)).toBe(true);
});
