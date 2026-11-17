import { proxyPath } from "@/lib/board-arrange-optimize";
import { BOARD_GRID } from "@/lib/board-grid";

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };

export function isDockedOnCard(point: Point | undefined, card: Bounds): boolean {
  if (!point) return false;
  // The published obstacle bounds are rounded, while React Flow positions can be fractional.
  const tolerance = 1;
  const { x, y } = point;
  const { left, top, right, bottom } = card;
  return x >= left - tolerance && x <= right + tolerance &&
    y >= top - tolerance && y <= bottom + tolerance &&
    Math.min(Math.abs(x - left), Math.abs(x - right), Math.abs(y - top), Math.abs(y - bottom)) <= tolerance;
}

/** A temporary connection between live card rims while the real route catches up. */
export function previewDraggedWire(
  source: Bounds,
  target: Bounds,
  selfLoop: boolean,
  waypoints: readonly Point[] = [],
): Point[] {
  if (waypoints.length > 0) {
    const asRect = ({ x, y }: Point): Bounds => ({ left: x, right: x, top: y, bottom: y });
    const start = proxyPath(source, asRect(waypoints[0]!))[0]!;
    const end = proxyPath(target, asRect(waypoints[waypoints.length - 1]!))[0]!;
    return [start, ...waypoints, end];
  }
  if (selfLoop) {
    const x = (source.left + source.right) / 2;
    const y = (source.top + source.bottom) / 2;
    const right = source.right + BOARD_GRID;
    const top = source.top - BOARD_GRID;
    return [{ x: source.right, y }, { x: right, y }, { x: right, y: top }, { x, y: top }, { x, y: source.top }];
  }
  return proxyPath(source, target);
}
