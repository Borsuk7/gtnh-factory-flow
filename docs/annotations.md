# Board annotations

Notes, boxes, arrows, zones, and images are saved in the plan and travel with it between the website and the mod.

## What is supported

| Kind | Website pencil menu | Mod board menu | Edited |
| --- | --- | --- | --- |
| `text` (sticky note) | Add text note | Add sticky note | its own menu: write, colour, text size, delete |
| `box` | Draw box | Add box | menu: colour, fill, border, marks, delete; drag, resize |
| `arrow` | Draw arrow | Add arrow | menu: colour, thickness, heads, delete; drag, reshape |
| `zone` (polygon outline) | Draw zone | Imported zones can be edited | colour, fill, border, marks, delete; move; resize by its bottom right corner |
| `image` | Add an image | Preserved on import and export | website: move, resize, caption, delete |

The website uploads images to its configured image host and stores their URLs in the plan. The mod preserves those
annotations on export and omits them from its board view.

## The model (the website's `FactoryAnnotation`, plan JSON `annotations[]`)

| Field | Kinds | Meaning |
| --- | --- | --- |
| `id`, `kind` | all | `box`, `zone`, `arrow`, `text`, `image` |
| `position`, `size` | all | top-left and bounding box, board px (the website's and the mod's are one to one since 2026-10-15). An arrow's size may be 0 on one axis: a level arrow |
| `colorTag` | all | one of the 22 colour tags; absent = yellow |
| `text` | text, image | note body or image caption |
| `fontSize` | text | 8..96, 14 default |
| `arrowDirection` | arrow | `down-right` (default), `down-left`, `up-right`, `up-left`: tail to head across the bounding box. Dragging an end past the other flips it |
| `arrowHeads` | arrow | `end` (default, a head at the head end) or `both` |
| `arrowWidth` | arrow | the line's thickness in board px: 1 thin, 2 normal (default), 4 thick; 1..8 allowed |
| `points` | zone | closed outline, vertices relative to `position` (3 or more) |
| `imageUrl` | image | hosted image URL |
| `style.border` | box, zone | `solid` (default), `dashed`, `none` (a plan can carry it; the menu offers solid and dashed) |
| `style.borderColor`, `style.fillColor` | box, zone | colour tags; absent = `colorTag`. The menu's Colour sets `colorTag` and lets these go |
| `style.fill` | box, zone | `tint` (default), `solid`, `none`; the legacy mark names (`dots`, `grid`, `graph`, `ruled`, `hatch`) mean tint wearing that mark, `paper` means solid. Choosing a fill from the menu keeps a legacy mark |
| `style.marks` | box, zone | `none`, `dots`, `grid`, `graph`, `ruled`, `hatch` |
| `style.fillTheme` | box, zone | a textured paper; not drawn, kept in the data (a menu colour pick drops it) |
| `pocketId` | all | the group (board) it lives in, its position measured from that group's frame (docs/design/groups.md) |

Nothing here takes part in the solve, the wiring or Arrange. The website keeps unknown fields; the mod keeps the ones
above. Old builds ignore `arrowHeads` and `arrowWidth` and draw a normal one-headed arrow.

## The look (the clean card's: flat, square, 1 px chrome, Monocraft)

Colours are the colour tag's swatch (`GT_NODE_COLORS` / `NoteColors.SWATCH`, same 22). Sizes are in board px, the
website's and the mod's one to one since the website's board draws the mod's card (2026-10-15; its `drawing-look.ts`
`DRAWING`).

- **Box**: a square rectangle. Border 2 px in the border colour (`dashed`: 8 on, 6 off), nothing rounded, no
  shadow. Surface: `tint` is the fill colour at 8% alpha (`0x14`), `solid` at 28% (`0x47`), flat; `none` is empty.
  Marks over the surface in the fill colour at 16..35%: dots (a pixel per 10 px cell), grid (1 px lines per cell),
  graph (grid plus a stronger line every 5 cells), ruled (a line every 2 cells), hatch (diagonals).
- **Zone**: the box's look on the outline `points` (square joins, flat fill, same border, surface and marks).
- **Arrow**: a line of `arrowWidth` px (2) in the colour from the tail corner to the head corner, ending in a flat
  filled head, at one end or both. The head is 14 long and 10 wide, bigger on a thick line (4 times the thickness
  long, 3 times wide, whichever is more).

Order, back to front: boxes and zones (under everything, the board's backdrop), drawers and cards, and arrows with
the notes (over the wires). A box and a zone are click-through inside: only the border takes the pointer; an arrow
only its line and its ends.

## Making and editing

On the website, open the pencil to choose a tool. Drag to draw a board, box, or arrow. Click each corner of a zone,
then click the first corner to close it. Click the board to place a note and start writing. The mod adds notes, boxes,
and arrows through the board's right-click menu.

**Right-click** a box, zone or arrow (on its border or line; the website only on a plan board). A box or zone:
Colour..., Fill... (Tint, Solid, None), Border... (Solid, Dashed), Marks... (None, Dots, Grid, Graph, Ruled, Hatch),
Delete. An arrow: Colour..., Thickness... (Thin, Normal, Thick), Heads... (One end, Both ends), Delete. Each "..." row
opens a short list with the current choice ticked; a pick is one undoable step. A sticky note keeps its own menu.

**Direct**, as notes do (a press let go within 3 GUI px is a click and selects; moved further it acts):

- *Box*: drag its border (the line and a band inside it) to move it; drag a corner, or just outside an edge, to resize
  it from that side (to the 10 px grid, never under two cells; the far side stays). A zone moves by its outline and
  resizes by its bottom right corner.
- *Arrow*: drag its line to move it; drag either end handle to reshape it (the end lands on the grid, the other stays,
  and dragging past it flips the direction; the ends may line up but never meet). The handles show while it is
  selected or the pointer is on it.
- Selecting: a click (Shift adds), marquee, select all. Delete or Backspace removes the selection. Everything is in
  undo, copy and paste and saves with the plan. A selection outline shows only with two or more things selected; a
  single drawing shows its handles (corners, ends) instead.

## Plan JSON both ways

Import keeps every field above (mod `importer/FfPlanParser` to `FfConverter.placeNotes`); export writes them back
(`library/PlanExport.note`). Positions are board px one to one and sizes are snapped to whole 20 px cells (an arrow's
0 axis stays 0); zone points are as they are. Shared plans carry each drawing exactly, with the game's data on it
(docs/design/cloud-live.md, Game mapping). The mod saves them as a `kind` on its note
(`data/flowchart/Note`), so older saves are all text.

## Where it is (code)

Website: `src/components/flow/clean/note/` (`CleanDrawing` the shapes, handles and resize; `AnnotationMenu` the menu;
`drawing-look.ts` the look and the pure helpers `arrowFromEnds`, `boxStyleWith`; `note-actions.ts` Add box and Add
arrow), `BoardContextMenu.tsx` (the board menu), the store's `updateAnnotation` (an arrow keeps a 0 axis).
Mod: `ui/note/NoteCard` (menu, handles, drag), `DrawingGrips` (what is held where and what dragging does: pure,
tested), `DrawingPaint` (look and hit), `BoardCanvas.openBoardMenu`, `BoardSession.addDrawing`.
