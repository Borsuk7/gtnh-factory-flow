# Sounds (src/lib/sound)

The board sounds exactly like the in-game planner: the mod's own rendered files, played by the mod's rules.

- Files: `public/sounds/<group>/<name><take>.ogg`, five takes a sound, copied untouched from the mod's
  `src/main/resources/assets/gtnhplanner/sounds/` (made by its `tools/sound/synth.mjs`; `docs/design/sound.md` there).
  Never edit or re-render them here; copy them again when the mod's change. `sfx.test.ts` checks every take is on disk.
- Player: `sfx.ts`, a port of the mod's `ui/sound/Sfx.java`. One level for everything (`SFX_BASE` 0.573, the mod's
  click matched to the game's) times the Sounds setting (Off 0, Quiet 0.5, Normal 1, Loud 1.7; Normal by default, key
  `gtnh-factory-flow.sound-level.v2`). Takes dealt like a shuffled deck; each play steps the pitch -2/0/0/0/+2 semitones
  and lands it on the pentatonic scale (0 2 4 7 9 12); loudness +-1 dB; pitch is playback rate, clamped 0.5..2.
  Repeats inside 120 ms duck x0.6 (three steps), inside 30 ms are dropped. The click gives way: a sound that says more
  within 80 ms drops it or stops it (it is scheduled 20 ms ahead so a stopped click is never heard).
- Audio unlock: browsers start audio suspended; the first press or key resumes it (`installSfxUnlock`) and starts the
  downloads (also on idle). A sound asked for while loading or waking plays if it is under 250 ms late.
- Where they come from: `board-diff.ts` (the plan before and after an edit: `soundForDiff`, pure and tested),
  `board-gestures.ts` (the page's own pointer, click and wheel events), and a few explicit calls where an action has a
  sound the plan cannot show. `components/flow/use-board-sound-effects.ts` wires them up. An explicit call that also
  edits the plan claims the edit (`playEditSfx`, `claimEdit`) so the diff stays quiet for it.
- Older call sites still call `playBoardSound(kind)` in `src/lib/board-sounds.ts`, which maps each old kind to the mod
  sound for that action (`tick` and `shelfTick` are the click, `pageOpen` is `ui.open`, `dialPower` is the tier dial...).
  New code calls `sfx.ts`.
- Nothing plays while the tour catches up to a step (`setSfxHurried`), for 1.5 s after a plan loads (`quietSfxFor`),
  or in a hidden tab.

## What plays where (mod event -> website)

| Sound | Mod (`Sfx` call sites) | Website |
|---|---|---|
| `ui.click` | anything pressed (`Hyb.click`) | any button, role=button/menuitem/tab/radio/switch, link, or pointer-cursor element clicked (`board-gestures` click listener); a control with `data-sfx-own` plays its own instead |
| `ui.click` x0.6 at 1.15 | a card or drawer selected | a press on a card, drawer or note that does not move 3 px |
| `ui.toggle_on` / `_off` | a setting switched | gear switch rows, feedback mood faces, checklist on/off |
| `ui.open` / `ui.close` | a popup opening; dismissed by a press outside or Esc | every dropdown (`useDropdownDismiss`: menus, pickers, the board's right-click menus, the non-recipe picker); the gear box opening and closing; a board unfolding/folding; a plan tab closed |
| `ui.deny` | refused: wire dropped where nothing takes it, nothing to undo | a wire drop that changed nothing; undo/redo with empty history |
| `ui.tick` (1.12 up, 0.9 down) | a wheel step on a value | a wheel step that changed the plan (count, rate, amps...), the top bar's wheel keys, the gear's choice rows and section wheel, a note's text size |
| `ui.tick` (scale run) | Arrange under way, a note higher each tenth | `reportArrange` (`chrome/board-commands.ts`), 90 ms apart |
| `ui.page` | tab switched or added, library opened/closed, NEI pages turned | plan tab switched, New plan, library opened/closed (`library-tab.ts`), recipe search pages |
| `board.place` | a card added, one card pasted | one new card in the plan |
| `board.sweep` | Arrange landing, several pasted, a plan imported | two or more cards (or three things) landing at once; Arrange finishing |
| `board.remove` | cards or drawers deleted | cards or drawers gone from the plan |
| `board.lift` / `board.drop` | a card, drawer or note picked up once it moves; set down | a press on a card, drawer or note moving 3 px; let go |
| `board.clone` | a card cloned | the card menu's Clone node (`cloneWithSound`) |
| `board.merge` | cards combined onto one machine | cards leave and a survivor gains their recipes (Combine) |
| `board.undo` / `board.redo` | undo, redo | `undo` / `redo` in the store (every key and button goes through them) |
| `board.pin` / `board.unpin` | a count pinned, a drawer's or port's rate set or cleared | `solvePin`, `portRates`, a drawer's `targetPerSecond` set or cleared; under the wheel it plays once the wheel has been still 500 ms (the mod's `live`) |
| `board.adjust` | a setting changed; coil pitched 0.8 x1.05 per rung; drawer rule or kind pitched 0.9 x1.12 per rung | any other card or drawer setting; coil, drawer rule (Any, At least, Exactly, At most), drawer kind and buffer mode pitched by rung; a note's colour |
| `board.running` | a solve has the plan running where it did not before | the books go from no machine working to some working, on the same plan, not after an undo |
| `wire.grab` | a wire picked up off a port (once it leaves it) | a press on a port's handle moving 3 px |
| `wire.snap` | the wire in hand comes over a port that takes it | the snap in `FactoryFlow` (old kind `snap`) |
| `wire.item` / `wire.fluid` / `wire.power` | a wire or drawer link made, a drawer made for a port, by what it carries | a new wire (by `resourceKind`), a new drawer (by its `kind`) |
| `wire.cut` / `wire.fluid_cut` / `wire.power_cut` | a wire cut, as what it carried | a wire gone with no card or drawer gone |
| `dial.tier` (0.62 x1.085 per tier) | a voltage tier stepped, ULV low to MAX high | `overclockTier` or `hatchVoltageTier` changed, the old `dialPower` kind |
| `note.stick` / `note.crumple` | a sticky note added; deleted | an annotation added or removed; feedback sent |

Not ported: `world.place` / `world.remove` (there is no world on the website).

Verify with the Playwright probe pattern: hook `AudioBufferSourceNode.prototype.start` and `stop` (map buffers to
files through `Response.arrayBuffer` and `decodeAudioData`), drive the tour (`window.__tour`) and a few scripted
actions, and log which file started per action.
