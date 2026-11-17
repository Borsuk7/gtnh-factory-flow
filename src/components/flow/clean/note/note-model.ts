import { snapSizeUpToGrid } from "@/lib/board-grid";
import type { FactoryAnnotation, FactoryNodeColorTag } from "@/lib/model/types";
import { mixHex } from "../colors";
import { GT_NODE_COLORS } from "../../node-colors";

/**
 * The mod's sticky note (`ui/note/NoteCard`, `NoteColors`, `NoteText`) as pure
 * functions. A note is the website's text annotation (kind "text", a colour tag,
 * a font size), so plans keep carrying it both ways. Its chrome numbers are the
 * mod's board pixels one to one: the board places and sizes everything as the
 * mod does (a card 320 wide), so a note looks the same in both.
 */

export const NOTE = {
  /** Folded corner, at most (shrinks on a small note). */
  fold: 14,
  /** How deep the edges that resize reach in, in screen px (kept however far out the board is). */
  edge: 10,
  /** The three keys: side, gap between the two on the right, inset from the edge. */
  key: 9,
  keyGap: 2,
  keyInset: 3,
  /** The glued strip along the top, where the keys sit. */
  band: 11,
  /** The text's margin from the edges, and its first line's top. */
  pad: 7,
  textTop: 11 + 4,
  /** The note's own units (the mod and the website share them): new size, smallest, text sizes and their step. */
  defaultWidth: 180,
  defaultHeight: 120,
  minWidth: 100,
  minHeight: 40,
  defaultFont: 14,
  minFont: 8,
  maxFont: 96,
  fontStep: 2,
  defaultColor: "yellow" as FactoryNodeColorTag,
  /** A press let go within this many screen px is a click, not a carry. */
  slop: 3,
  /** The text at the default size in board px: 9 high (the mod's pixel font), an 11 px line, as the mod's. */
  glyphAtDefault: 9,
  lineAtDefault: 11,
} as const;

/** The colours the note menu offers, in the mod's order, with its names. */
export const NOTE_COLOR_MENU: ReadonlyArray<readonly [FactoryNodeColorTag, string]> = [
  ["yellow", "Yellow"],
  ["orange", "Orange"],
  ["pink", "Pink"],
  ["scarlet", "Red"],
  ["lime", "Lime"],
  ["emerald", "Green"],
  ["light_blue", "Light blue"],
  ["azure", "Blue"],
  ["purple", "Purple"],
  ["white", "White"],
  ["steel", "Grey"],
];

export interface NotePalette {
  paper: string;
  band: string;
  fold: string;
  edge: string;
  ink: string;
}

function luminance(hex: string): number {
  const v = Number.parseInt(hex.replace("#", ""), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
}

/** The note's colours from its tag: paper is the swatch a quarter of the way to white, the rest darker shades of it. */
export function notePalette(tag: FactoryNodeColorTag | undefined): NotePalette {
  const swatch = (GT_NODE_COLORS[tag ?? NOTE.defaultColor] ?? GT_NODE_COLORS[NOTE.defaultColor]).swatch;
  const paper = mixHex("#FFFFFF", swatch, 0.25);
  return {
    paper,
    band: mixHex("#000000", paper, 0.07),
    fold: mixHex("#000000", paper, 0.2),
    edge: mixHex("#000000", paper, 0.14),
    ink: luminance(paper) < 0.34 ? "#F2F3F7" : "#1E1E22",
  };
}

export type NotePart = "body" | "delete" | "smaller" | "bigger" | "resize";

/** How many note units a screen pixel takes: 1 at the board's own scale and closer, more zoomed out. */
export function keyUnit(zoom: number): number {
  return Math.max(1, 1 / (zoom > 0 ? zoom : 1));
}

export function foldSize(w: number, h: number): number {
  return Math.max(6, Math.min(NOTE.fold, Math.floor(Math.min(w, h) / 4)));
}

/** Whether the three keys fit on the note at their size, with room between the left one and the right two. */
export function keysFit(w: number, h: number, zoom: number): boolean {
  const u = keyUnit(zoom);
  return w >= (3 * NOTE.key + 2 * NOTE.keyGap + 2 * NOTE.keyInset) * u && h >= (2 * NOTE.key + 1) * u;
}

/** A key's note-local rectangle. */
export function keyRect(key: "delete" | "smaller" | "bigger", w: number, zoom: number) {
  const u = keyUnit(zoom);
  const k = NOTE.key * u;
  const inset = NOTE.keyInset * u;
  switch (key) {
    case "delete":
      return { x: inset, y: u, w: k, h: k };
    case "smaller":
      return { x: w - 2 * k - NOTE.keyGap * u - inset, y: u, w: k, h: k };
    case "bigger":
      return { x: w - k - inset, y: u, w: k, h: k };
  }
}

/** Which part of a note a note-local point is on (keys first, then the resizing corner and edges). */
export function partAt(x: number, y: number, w: number, h: number, zoom: number, keysShown: boolean): NotePart {
  if (keysShown) {
    for (const key of ["delete", "smaller", "bigger"] as const) {
      const r = keyRect(key, w, zoom);
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return key;
    }
  }
  const f = foldSize(w, h);
  const edge = NOTE.edge * keyUnit(zoom);
  const corner = f + edge;
  if (x >= w - corner && y >= h - corner) return "resize";
  if (x >= w - edge || y >= h - edge) return "resize";
  return "body";
}

/** Which way a resize press drags: the corner and its margin both, an edge's band its own way. */
export function resizeAxes(x: number, y: number, w: number, h: number, zoom: number) {
  const edge = NOTE.edge * keyUnit(zoom);
  const reach = foldSize(w, h) + edge;
  const corner = x >= w - reach && y >= h - reach;
  return { w: corner || x >= w - edge, h: corner || y >= h - edge };
}

export function clampFont(value: number): number {
  return Math.min(Math.max(Math.round(value), NOTE.minFont), NOTE.maxFont);
}

export function fontOf(annotation: Pick<FactoryAnnotation, "fontSize">): number {
  return clampFont(annotation.fontSize ?? NOTE.defaultFont);
}

/** Text size on screen, in CSS px: the mod's glyph at its size scale. */
export function glyphPx(font: number): number {
  return (NOTE.glyphAtDefault * font) / NOTE.defaultFont;
}

/** A line's height in CSS px at a text size. */
export function linePx(font: number): number {
  return (NOTE.lineAtDefault * font) / NOTE.defaultFont;
}

export type Measure = (text: string, fontPx: number) => number;

/** The width the text wraps at, in CSS px. */
export function wrapWidth(noteWidth: number): number {
  return Math.max(10, noteWidth - 2 * NOTE.pad);
}

/**
 * Lines the text wraps to at a width: each paragraph broken after the last space that fits, a word wider than the
 * line broken where it must (the mod's NoteText, one letter at least per line).
 */
export function wrapLines(text: string, maxWidth: number, fontPx: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let start = 0;
    while (start < paragraph.length) {
      let end = start;
      let lastSpace = -1;
      while (end < paragraph.length && measure(paragraph.slice(start, end + 1), fontPx) <= maxWidth) {
        if (paragraph[end] === " ") lastSpace = end;
        end++;
      }
      if (end >= paragraph.length) {
        out.push(paragraph.slice(start));
        break;
      }
      const cut = lastSpace >= start ? lastSpace + 1 : Math.max(end, start + 1);
      out.push(paragraph.slice(start, cut));
      start = cut;
    }
  }
  return out;
}

/** The height that shows every line of `text` at the note's width and text size, up to the next cell. */
export function neededHeight(text: string, width: number, font: number, measure: Measure): number {
  const lines = wrapLines(text, wrapWidth(width), glyphPx(font), measure).length;
  return snapSizeUpToGrid(NOTE.textTop + lines * linePx(font) + Math.max(4, NOTE.fold / 2) + 3);
}

/** Text annotations use the sticky note renderer on plan boards. */
export function isStickyNote(annotation: Pick<FactoryAnnotation, "kind">): boolean {
  return annotation.kind === "text";
}

/** A new note as the mod makes one: yellow, 180 by 120, at a board point, empty. */
export function newStickyNote(at: { x: number; y: number }): Omit<FactoryAnnotation, "id"> {
  return {
    kind: "text",
    colorTag: NOTE.defaultColor,
    text: "",
    position: { x: at.x, y: at.y },
    size: { width: NOTE.defaultWidth, height: NOTE.defaultHeight },
  };
}

/** The note a menu just made, to start writing on once its widget exists: asked for here, taken once by the widget. */
let pendingEdit: string | undefined;
export function requestNoteEdit(id: string): void {
  pendingEdit = id;
}
export function takeNoteEditRequest(id: string): boolean {
  if (pendingEdit !== id) return false;
  pendingEdit = undefined;
  return true;
}

/** Whether more than one of the nodes is selected: a note's selection outline shows only then. */
export function severalSelected(nodes: Iterable<{ selected?: boolean }>): boolean {
  let count = 0;
  for (const node of nodes) {
    if (node.selected && ++count > 1) return true;
  }
  return false;
}
