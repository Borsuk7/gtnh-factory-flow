# The overview rail and the notices bar (src/components/flow/clean/rail)

The mod's `OverviewRail`, `SpareBar`, `SparePopup` and `NoticeBar` on the website, for plan-mode boards
(`project.planMode`). A column LEFT of the board (between the item browser and the board; it folds to a 26 px
strip, kept per device in `rail-view.ts`). On those boards the right-hand `InspectorPanel` steps aside; the old
modes keep it.

- Data is pure and tested: `rail-model.ts` (totals, setters, open ports, machines from `buildMachineList`),
  `spare-model.ts` (leftovers with a choice, most upstream first, stored split first), `rail-layout.ts` (the list as
  items with tops and heights; the component draws only the slice in view), `notices.ts` (the catalogue of the UI spec
  11.2 from the solver's notes). `rail-data.ts` shares one computation per (project, solve).
- Selecting machines, drawers, or a board with either scopes the shared resource list to that selection.
  The rates use the current solve's wires, open ports, forced ports, and drawer boundaries. Clearing the
  selection restores the full Overview. The device setting Follow selection in Overview can keep the full
  Overview visible while cards are selected. The machine list stays at the bottom and covers the plan.
- Avg uses the solved running count. Peak uses the configured count on a partly running capped card.
  The total draw tooltip divides the current EU/t by each tier's voltage.
- Edits go through `rail-actions.ts`: the store's own actions (one undo step each), except a spare's split while its bar
  is in hand (`previewSpare`: re-solves, no history; `endSpareDrag`: one undo step made from the project as it was
  taken, or none if the split did not move). Wheel steps are held on screen and committed once the wheel is still
  (350 ms), so a spin is one undo step.
- A control under the pointer takes the wheel unless the list was scrolled by the wheel in the last 400 ms: one
  native non-passive listener on the list (`rail-controls.tsx`, `wheelHandlerFor`). With "Scroll changes values" off
  no control takes it and the list always scrolls. An open box given `onWheelDraft` steps the text it holds, set when
  the box is let go of; given `onLive` too it sets as it goes (each step at once, typing once it rests, never an
  emptied box) and Escape calls `onRevert`. The machine count does both, as the card's box does.
- Rows hang `data-resource-row`; hovering one sets `hoveredFlowResourceKey` (the board lights the resource), a spare's
  place sets `hoveredFlowScope` on its ports. Controls stop their clicks so the row (walk to the next card that makes or
  uses the resource) never sees them.
- `NoticeBar.tsx`: `PlanNoticeSwitch` is mounted in the board's notice corner and shows the plan-mode bar
  (`PlanBoardOverlays`: notices, `SparePopupHost`, `RailTipHost`) or the classic notices. `flashNotice` puts a
  transient sentence on top for 7 s.
- `rail-tip.tsx` owns the rail's 800 ms tooltip delay.
- Fonts live on spans and divs, never on a `<button>` (globals.css forces `font: inherit` on buttons); every control
  is a `div role=button`. State hangs on data attributes.
- Type is Monocraft at 10 px (`RAIL_FONT`), measured with `measureClean`; rate boxes are 44 and keys 16 (controls 62, the mod's 26% of the rail). A machine line drops its unit when it does not fit, as the mod does; names ellipsize. The rail is 234 CSS px in shell units (screen px = x the UI scale, 273.8 at the default 1.17): measure with `offsetWidth`.
- The notices ride the TOP of the board (`PlanTopNotices`, under the toolbars). A failed solve (nothing set) counts no flows. Only resource rows and spare places light the board on hover; the mod's machine lines light nothing (OverviewRail.java drawRail).
