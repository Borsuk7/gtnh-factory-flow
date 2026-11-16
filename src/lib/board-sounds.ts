/**
 * The older call sites' sound vocabulary, played as the mod's sounds. Every
 * sound is now one of the mod's rendered files through `./sound/sfx.ts`; this
 * file maps each kind those callers name to the mod sound for that action and
 * keeps the Sounds setting's old helpers working. New code calls `sfx.ts`
 * directly. The mapping is the table in `./sound/AGENTS.md`.
 */

import {
  claimEdit,
  DEFAULT_SOUND_LEVEL,
  getSoundLevel,
  installSfxUnlock,
  playSfx,
  playSfxStep,
  quietSfxFor,
  setSoundLevel,
  sfxConnect,
  sfxCut,
  sfxTier,
  SOUND_LEVEL_GAINS,
  type SfxName,
} from "./sound/sfx";

/** The default master volume (the mod's Normal); the settings work in the mod's gains. */
export const DEFAULT_BOARD_SOUND_VOLUME = SOUND_LEVEL_GAINS[DEFAULT_SOUND_LEVEL];

export function areBoardSoundsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return getSoundLevel() > 0;
}

export function setBoardSoundsEnabled(enabled: boolean): void {
  if (!enabled) setSoundLevel(0);
  else if (getSoundLevel() === 0) setSoundLevel(DEFAULT_SOUND_LEVEL);
}

/** The Sounds setting as its gain (0, 0.5, 1, 1.7). */
export function getBoardSoundVolume(): number {
  if (typeof window === "undefined") return DEFAULT_BOARD_SOUND_VOLUME;
  return SOUND_LEVEL_GAINS[getSoundLevel()];
}

/** Sets the Sounds setting to the level nearest `volume` (never Off: that is `setBoardSoundsEnabled`). */
export function setBoardSoundVolume(volume: number): void {
  let best = 1;
  for (let index = 1; index < SOUND_LEVEL_GAINS.length; index++) {
    if (Math.abs(SOUND_LEVEL_GAINS[index] - volume) < Math.abs(SOUND_LEVEL_GAINS[best] - volume)) best = index;
  }
  if (getSoundLevel() > 0) setSoundLevel(best);
}

/** A loaded plan is not an action: nothing plays for a moment. */
export function quietBoardSoundsFor(ms: number): void {
  quietSfxFor(ms);
}

const kindQuietUntil = new Map<BoardSoundKind, number>();

/** Mutes one kind for a moment; the edit in hand already sounded, so the plan watcher stays quiet for it. */
export function suppressBoardSound(kind: BoardSoundKind, ms: number): void {
  if (typeof performance === "undefined") return;
  claimEdit();
  kindQuietUntil.set(kind, Math.max(kindQuietUntil.get(kind) ?? 0, performance.now() + ms));
}

export type BoardSoundKind =
  | "checklistOn" | "checklistOff" | "checklistCheck" | "checklistRestore"
  | "place" | "placeProduct" | "placeSource" | "delete"
  | "connect" | "zap" | "zapOff" | "snap" | "unwire" | "error"
  | "open" | "close" | "adjust"
  | "drawerOverflow" | "drawerStrict" | "drawerRatio"
  | "sweep" | "solveOn" | "solveOff" | "buildOn" | "poolOn" | "poolOff"
  | "shuffle" | "shuffleWire" | "shuffleBoard"
  | "dialRate" | "dialEnergy" | "dialPower"
  | "pageOpen" | "pageClose" | "pageTurn" | "tick" | "stencilAdd" | "stencilRemove"
  | "shelfTurn" | "shelfTick";

/** The mod sound each older kind is. */
const PLAIN: Partial<Record<BoardSoundKind, SfxName>> = {
  checklistOn: "ui.toggle_on",
  checklistOff: "ui.toggle_off",
  checklistCheck: "ui.click",
  checklistRestore: "ui.click",
  place: "board.place",
  delete: "board.remove",
  snap: "wire.snap",
  error: "ui.deny",
  open: "ui.open",
  close: "ui.close",
  adjust: "board.adjust",
  sweep: "board.sweep",
  solveOn: "ui.click",
  solveOff: "ui.click",
  buildOn: "ui.click",
  poolOn: "ui.click",
  poolOff: "ui.click",
  shuffle: "board.place",
  shuffleBoard: "board.sweep",
  dialRate: "ui.click",
  dialEnergy: "ui.click",
  pageOpen: "ui.open",
  pageClose: "ui.close",
  pageTurn: "ui.page",
  tick: "ui.click",
  stencilAdd: "ui.click",
  stencilRemove: "ui.click",
  shelfTurn: "ui.page",
  shelfTick: "ui.click",
};

/** Starts the downloads and resumes audio on the first gesture. */
export function primeBoardSounds(): void {
  installSfxUnlock();
}

export function playBoardSound(
  kind: BoardSoundKind,
  options?: {
    /** Scales this one sound. */
    gain?: number;
    /** The dial voices' rung: which choice was picked, 0 upward. */
    step?: number;
  },
): void {
  if (typeof window === "undefined") return;
  if (performance.now() < (kindQuietUntil.get(kind) ?? 0)) return;
  switch (kind) {
    case "placeProduct":
    case "placeSource":
    case "connect":
    case "shuffleWire":
      sfxConnect("item");
      return;
    case "zap":
      sfxConnect("power");
      return;
    case "zapOff":
      sfxCut("power");
      return;
    case "unwire":
      sfxCut("item");
      return;
    case "drawerOverflow":
    case "drawerStrict":
    case "drawerRatio":
      playSfxStep("board.adjust", ["drawerOverflow", "drawerStrict", "drawerRatio"].indexOf(kind), 0.9, 1.12);
      return;
    case "dialPower":
      // Callers pass the tier's index plus one (0 for "auto").
      claimEdit();
      sfxTier(Math.max(0, (options?.step ?? 1) - 1));
      return;
    default: {
      const name = PLAIN[kind];
      if (name) playSfx(name, options?.gain ?? 1);
    }
  }
}
