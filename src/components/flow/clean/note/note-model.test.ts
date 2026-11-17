import { describe, expect, it } from "vitest";
import { GT_NODE_COLORS } from "../../node-colors";
import {
  NOTE,
  NOTE_COLOR_MENU,
  clampFont,
  fontOf,
  foldSize,
  isStickyNote,
  keyRect,
  keyUnit,
  keysFit,
  neededHeight,
  newStickyNote,
  notePalette,
  partAt,
  requestNoteEdit,
  resizeAxes,
  severalSelected,
  takeNoteEditRequest,
  wrapLines,
} from "./note-model";

/** Monospace stand-in for the canvas: every letter is half the font's size wide. */
const measure = (text: string, size: number) => text.length * size * 0.5;

describe("note colours", () => {
  // NoteColors.java: paper = the swatch a quarter of the way to white; band, edge and fold darker shades of it.
  it("matches the mod's yellow", () => {
    // swatch FED83D: 0.25*255 + 0.75*channel, rounded half up; band 7%, edge 14%, fold 20% black
    const p = notePalette("yellow");
    expect(p.paper).toBe("#FEE26E");
    expect(p.band).toBe("#ECD266");
    expect(p.edge).toBe("#DAC25F");
    expect(p.fold).toBe("#CBB558");
    expect(p.ink).toBe("#1E1E22");
  });

  it("uses light ink on dark paper (the website's luminance test)", () => {
    expect(notePalette("black").ink).toBe("#F2F3F7");
    expect(notePalette("steel").ink).toBe("#F2F3F7");
    expect(notePalette("white").ink).toBe("#1E1E22");
  });

  it("an unknown or missing tag reads as yellow", () => {
    expect(notePalette(undefined)).toEqual(notePalette("yellow"));
    expect(notePalette("nope" as never)).toEqual(notePalette("yellow"));
  });

  it("every swatch is the mod's", () => {
    // NoteColors.SWATCH
    const mod: Record<string, string> = {
      white: "#F0F0F0",
      orange: "#F9801D",
      magenta: "#C74EBD",
      light_blue: "#3AB3DA",
      yellow: "#FED83D",
      lime: "#80C71F",
      pink: "#F38BAA",
      gray: "#474F52",
      light_gray: "#9D9D97",
      cyan: "#169C9C",
      purple: "#8932B8",
      blue: "#3C44AA",
      brown: "#835432",
      green: "#5E7C16",
      red: "#B02E26",
      black: "#1D1D21",
      scarlet: "#EF4444",
      amber: "#E0A63A",
      emerald: "#10B981",
      azure: "#3B82F6",
      steel: "#3C3E45",
      onyx: "#303238",
    };
    for (const [tag, swatch] of Object.entries(mod)) {
      expect(GT_NODE_COLORS[tag as keyof typeof GT_NODE_COLORS].swatch.toUpperCase(), tag).toBe(swatch);
    }
  });

  it("the menu lists the mod's eleven colours in its order", () => {
    expect(NOTE_COLOR_MENU.map(([, name]) => name)).toEqual([
      "Yellow",
      "Orange",
      "Pink",
      "Red",
      "Lime",
      "Green",
      "Light blue",
      "Blue",
      "Purple",
      "White",
      "Grey",
    ]);
    for (const [tag] of NOTE_COLOR_MENU) expect(GT_NODE_COLORS[tag]).toBeDefined();
  });
});

describe("note parts", () => {
  const w = 180;
  const h = 120;

  it("keys keep their screen size when zoomed out and show only when they fit", () => {
    expect(keyUnit(1)).toBe(1);
    expect(keyUnit(2)).toBe(1);
    expect(keyUnit(0.5)).toBe(2);
    expect(keysFit(w, h, 1)).toBe(true);
    expect(keysFit(100, 40, 1)).toBe(true);
    // Far out the keys would cover the whole note.
    expect(keysFit(100, 40, 0.25)).toBe(false);
    expect(keysFit(w, h, 0.1)).toBe(false);
  });

  it("the delete key is at the top left, text size at the top right", () => {
    const del = keyRect("delete", w, 1);
    const smaller = keyRect("smaller", w, 1);
    const bigger = keyRect("bigger", w, 1);
    expect(del.x).toBe(NOTE.keyInset);
    expect(bigger.x + bigger.w).toBe(w - NOTE.keyInset);
    expect(smaller.x + smaller.w + NOTE.keyGap).toBe(bigger.x);
    expect(partAt(del.x + 1, del.y + 1, w, h, 1, true)).toBe("delete");
    expect(partAt(smaller.x + 1, smaller.y + 1, w, h, 1, true)).toBe("smaller");
    expect(partAt(bigger.x + 1, bigger.y + 1, w, h, 1, true)).toBe("bigger");
    // Hidden keys are the band: part of the body.
    expect(partAt(del.x + 1, del.y + 1, w, h, 1, false)).toBe("body");
  });

  it("the corner and the right and bottom edges resize, the rest is body", () => {
    expect(partAt(w - 2, h - 2, w, h, 1, false)).toBe("resize");
    expect(partAt(w - 2, 60, w, h, 1, false)).toBe("resize");
    expect(partAt(60, h - 2, w, h, 1, false)).toBe("resize");
    expect(partAt(60, 60, w, h, 1, false)).toBe("body");
    // The edge's band is wider zoomed out (kept in screen pixels).
    expect(partAt(w - 15, 60, w, h, 1, false)).toBe("body");
    expect(partAt(w - 15, 60, w, h, 0.5, false)).toBe("resize");
  });

  it("an edge resizes its own way and the corner both", () => {
    expect(resizeAxes(w - 2, 60, w, h, 1)).toEqual({ w: true, h: false });
    expect(resizeAxes(60, h - 2, w, h, 1)).toEqual({ w: false, h: true });
    expect(resizeAxes(w - 2, h - 2, w, h, 1)).toEqual({ w: true, h: true });
    expect(resizeAxes(w - 2, h - 40, w, h, 1)).toEqual({ w: true, h: false });
  });

  it("the fold shrinks on a small note", () => {
    expect(foldSize(180, 120)).toBe(NOTE.fold);
    expect(foldSize(100, 40)).toBe(10);
    expect(foldSize(20, 20)).toBe(6);
  });
});

describe("note text", () => {
  it("wraps at word breaks and keeps blank lines", () => {
    expect(wrapLines("aaa bbb ccc", 6 * 5, 10, measure)).toEqual(["aaa ", "bbb ", "ccc"]);
    expect(wrapLines("one\n\ntwo", 100, 10, measure)).toEqual(["one", "", "two"]);
    expect(wrapLines("", 100, 10, measure)).toEqual([""]);
  });

  it("breaks a word wider than the line where it must, one letter at least", () => {
    expect(wrapLines("abcdefghij", 20, 10, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapLines("abc", 1, 10, measure)).toEqual(["a", "b", "c"]);
  });

  it("the needed height is a whole number of cells that shows every line", () => {
    const one = neededHeight("hi", 180, 14, measure);
    const many = neededHeight(Array.from({ length: 20 }, () => "line").join("\n"), 180, 14, measure);
    expect(one % 20).toBe(0);
    expect(many % 20).toBe(0);
    expect(many).toBeGreaterThan(one);
    expect(one).toBeGreaterThanOrEqual(NOTE.textTop + NOTE.lineAtDefault);
  });

  it("text sizes clamp to the website's range", () => {
    expect(clampFont(2)).toBe(8);
    expect(clampFont(500)).toBe(96);
    expect(fontOf({})).toBe(14);
    expect(fontOf({ fontSize: 22 })).toBe(22);
  });
});

describe("notes as the website's text annotations", () => {
  const annotations = [
    { id: "a", kind: "box" as const },
    { id: "b", kind: "text" as const },
    { id: "c", kind: "arrow" as const },
    { id: "d", kind: "zone" as const },
    { id: "e", kind: "image" as const },
    { id: "f", kind: "text" as const },
  ];

  it("only text annotations are sticky notes", () => {
    expect(annotations.filter(isStickyNote)).toHaveLength(2);
  });

  it("a new note is yellow, 180 by 120 (the mod's), empty, a text annotation", () => {
    expect(newStickyNote({ x: 40, y: 60 })).toEqual({
      kind: "text",
      colorTag: "yellow",
      text: "",
      position: { x: 40, y: 60 },
      size: { width: 180, height: 120 },
    });
  });

  it("an edit request is taken once, by the note it was for", () => {
    requestNoteEdit("n1");
    expect(takeNoteEditRequest("other")).toBe(false);
    expect(takeNoteEditRequest("n1")).toBe(true);
    expect(takeNoteEditRequest("n1")).toBe(false);
  });
});

describe("selection outline", () => {
  it("shows only when several things are selected", () => {
    expect(severalSelected([])).toBe(false);
    expect(severalSelected([{ selected: true }, { selected: false }, {}])).toBe(false);
    expect(severalSelected([{ selected: true }, { selected: false }, { selected: true }])).toBe(true);
  });
});
