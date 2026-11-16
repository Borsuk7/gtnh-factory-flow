/**
 * The board's sounds: the mod's own rendered files (`public/sounds/`, copied
 * from the mod's `assets/gtnhplanner/sounds/`, never edited) played by the
 * mod's rules (`ui/sound/Sfx.java`). What plays on which action is the table
 * in `./AGENTS.md`.
 *
 * Rules, as the mod has them:
 * - One volume for everything: `BASE` (the mod's level matched to the game's
 *   click) times the Sounds setting (Off, Quiet, Normal, Loud). The balance
 *   between sounds lives in the files.
 * - Each sound has five takes dealt like a shuffled deck, never the same take
 *   twice in a row. Each play steps the pitch a whole tone either way or none,
 *   landing on a pentatonic scale, and the loudness by up to a decibel.
 * - The click gives way: a sound that says more within 80 ms of a click drops
 *   it (or stops it if it already started).
 * - Repeats inside 120 ms duck to 0.6 a time (three steps at most); a repeat
 *   inside 30 ms is the same event twice and is dropped.
 * - Pitch is playback rate (the game resamples), clamped to 0.5..2.
 *
 * Browsers start audio suspended until a gesture: the first press or key
 * resumes the context (`installSfxUnlock`), and a sound asked for before that
 * plays once it resumes.
 */

export const SFX_NAMES = [
  "ui.click",
  "ui.toggle_on",
  "ui.toggle_off",
  "ui.open",
  "ui.close",
  "ui.deny",
  "ui.tick",
  "ui.page",
  "board.place",
  "board.remove",
  "board.lift",
  "board.drop",
  "board.clone",
  "board.merge",
  "board.sweep",
  "board.undo",
  "board.redo",
  "board.pin",
  "board.unpin",
  "board.adjust",
  "board.running",
  "wire.grab",
  "wire.snap",
  "wire.item",
  "wire.fluid",
  "wire.power",
  "wire.cut",
  "wire.fluid_cut",
  "wire.power_cut",
  "dial.tier",
  "note.stick",
  "note.crumple",
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

/** Takes per sound, as the mod's synth renders them. */
export const SFX_TAKES = 5;

/** The volume the mod plays its click at to match the game's own click (`Sfx.BASE`). */
export const SFX_BASE = 0.573;
const LOUDNESS_DB = 1;
const PITCH_STEPS = [-2, 0, 0, 0, 2];
const SCALE = [0, 2, 4, 7, 9, 12];
const SAME_MS = 30;
const REPEAT_MS = 120;
const DUCK = 0.6;
const DUCK_FLOOR = 3;
export const SAME_ACTION_MS = 80;
/** A sound asked for while the files load or the context wakes plays only this late at most. */
const LATE_MS = 250;

/** The mod's Sounds setting (`PlannerSettings.SOUND_GAINS`). */
export const SOUND_LEVEL_NAMES = ["Off", "Quiet", "Normal", "Loud"] as const;
export const SOUND_LEVEL_GAINS: readonly number[] = [0, 0.5, 1, 1.7];
export const DEFAULT_SOUND_LEVEL = 2;
const LEVEL_KEY = "gtnh-factory-flow.sound-level.v2";

/** The file one take lives in: `ui.toggle_on` take 3 is `/sounds/ui/toggle_on3.ogg`. */
export function sfxUrl(name: SfxName, take: number): string {
  const dot = name.indexOf(".");
  return `/sounds/${name.slice(0, dot)}/${name.slice(dot + 1)}${take}.ogg`;
}

export function getSoundLevel(): number {
  let level = DEFAULT_SOUND_LEVEL;
  try {
    const raw = window.localStorage.getItem(LEVEL_KEY);
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) level = Math.max(0, Math.min(SOUND_LEVEL_GAINS.length - 1, parsed));
    }
  } catch {
    // Storage blocked: the default stands.
  }
  return level;
}

export function setSoundLevel(level: number): void {
  const clamped = Math.max(0, Math.min(SOUND_LEVEL_GAINS.length - 1, Math.round(level)));
  try {
    if (clamped === DEFAULT_SOUND_LEVEL) window.localStorage.removeItem(LEVEL_KEY);
    else window.localStorage.setItem(LEVEL_KEY, String(clamped));
  } catch {
    // A blocked quota must never break the app.
  }
}

export function soundGain(): number {
  return SOUND_LEVEL_GAINS[getSoundLevel()] ?? 1;
}

/** A pitch moved to the nearest note of the scale, in whatever octave it is in (`Sfx.onScale`). */
export function onScale(pitch: number): number {
  const semis = (12 * Math.log(pitch)) / Math.log(2);
  const octave = Math.floor(semis / 12);
  const within = semis - octave * 12;
  let best = 0;
  for (const note of SCALE) if (Math.abs(note - within) < Math.abs(best - within)) best = note;
  return Math.pow(2, (octave * 12 + best) / 12);
}

// Audio plumbing ------------------------------------------------------------

let context: AudioContext | undefined;
const buffers = new Map<string, AudioBuffer | null>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
let decoder: BaseAudioContext | undefined;

function getDecoder(): BaseAudioContext | undefined {
  if (decoder) return decoder;
  if (typeof window === "undefined") return undefined;
  try {
    // An offline context decodes without a gesture; the buffers play in any context.
    decoder = new OfflineAudioContext(1, 1, 44100);
  } catch {
    decoder = getContext();
  }
  return decoder;
}

function getContext(): AudioContext | undefined {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return undefined;
  if (context && context.state === "closed") context = undefined;
  if (!context) {
    try {
      context = new AudioContext();
      // An inaudible constant source keeps the output stream awake: Chrome parks it after a few seconds of
      // silence and eats the front of the next short sound while it wakes.
      const keepAlive = context.createConstantSource();
      const quiet = context.createGain();
      quiet.gain.value = 0.0001;
      keepAlive.connect(quiet);
      quiet.connect(context.destination);
      keepAlive.start();
    } catch {
      return undefined;
    }
  }
  return context;
}

function load(url: string): Promise<AudioBuffer | null> {
  const known = loading.get(url);
  if (known) return known;
  const promise = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      const bytes = await response.arrayBuffer();
      const target = getDecoder();
      if (!target) return null;
      const buffer = await target.decodeAudioData(bytes);
      buffers.set(url, buffer);
      return buffer;
    } catch {
      buffers.set(url, null);
      return null;
    }
  })();
  loading.set(url, promise);
  return promise;
}

/** Fetches and decodes every take (about 1.3 MB), once. */
export function preloadSfx(): void {
  if (typeof window === "undefined") return;
  for (const name of SFX_NAMES) for (let k = 1; k <= SFX_TAKES; k++) void load(sfxUrl(name, k));
}

/** Resumes audio on the first gesture (browsers keep it suspended until one) and starts the downloads. */
export function installSfxUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const unlock = () => {
    const ctx = getContext();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    preloadSfx();
  };
  const options = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", unlock, options);
  window.addEventListener("keydown", unlock, options);
  window.addEventListener("touchend", unlock, options);
  const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (idle) idle(() => preloadSfx());
  else window.setTimeout(preloadSfx, 2000);
  return () => {
    window.removeEventListener("pointerdown", unlock, options);
    window.removeEventListener("keydown", unlock, options);
    window.removeEventListener("touchend", unlock, options);
  };
}

/** Gecko flushes audio graph commands at the end of the task, so it plays from a task of its own. */
const DEFERS_TO_TASK_END = typeof navigator !== "undefined" && /\bGecko\/\d/.test(navigator.userAgent);

interface Voice {
  source?: AudioBufferSourceNode;
  cancelled: boolean;
}

/**
 * How far ahead the click is scheduled: a sound that says more usually lands a task after it (the edit's own sound),
 * and stopping a click that has not started yet keeps even its first milliseconds out.
 */
const CLICK_AHEAD_S = 0.02;

function startVoice(url: string, volume: number, pitch: number, ahead = 0): Voice {
  const voice: Voice = { cancelled: false };
  const asked = performance.now();
  const go = (buffer: AudioBuffer | null) => {
    if (!buffer || voice.cancelled || performance.now() - asked > LATE_MS) return;
    const ctx = getContext();
    if (!ctx) return;
    const start = () => {
      if (voice.cancelled || performance.now() - asked > LATE_MS) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = pitch;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => gain.disconnect();
      source.start(ahead > 0 ? ctx.currentTime + ahead : 0);
      voice.source = source;
    };
    if (ctx.state !== "running") {
      void ctx.resume().then(start).catch(() => {});
    } else if (DEFERS_TO_TASK_END) {
      window.setTimeout(start, 0);
    } else {
      start();
    }
  };
  const ready = buffers.get(url);
  if (ready !== undefined) go(ready);
  else void load(url).then(go);
  return voice;
}

function stopVoice(voice: Voice): void {
  voice.cancelled = true;
  try {
    voice.source?.stop();
  } catch {
    // Already finished.
  }
}

// The player ----------------------------------------------------------------

interface SoundState {
  lastAt: number;
  streak: number;
  deck: number[];
  lastTake: number;
}

const states = new Map<SfxName, SoundState>();
let quietUntil = 0;
let lastSpecificAt = -1;
let lastClickAt = -1;
let lastClick: Voice | undefined;
let hurried: () => boolean = () => false;
let random: () => number = Math.random;

/** One play, for the log the tests and the dev tools read. */
export interface SfxPlay {
  at: number;
  name: SfxName;
  take: number;
  volume: number;
  pitch: number;
}

const recent: SfxPlay[] = [];
const listeners = new Set<(play: SfxPlay) => void>();

/** The last plays, newest last. */
export function recentSfx(): readonly SfxPlay[] {
  return recent;
}

export function onSfx(listener: (play: SfxPlay) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** No sounds while this says so (the tour catching up to a step). */
export function setSfxHurried(check: () => boolean): void {
  hurried = check;
}

/** No sounds for a moment: a plan loading, a tab switching (its cards are not landing, they were there). */
export function quietSfxFor(ms: number): void {
  if (typeof performance === "undefined") return;
  quietUntil = Math.max(quietUntil, performance.now() + ms);
}

/** When a sound other than the click and the wheel tick last played (ms, `performance.now()`), or -1. */
export function lastSpecificSfxAt(): number {
  return lastSpecificAt;
}

/** Tests: a fixed random source and a clean slate. */
export function resetSfxForTests(source: () => number = Math.random): void {
  states.clear();
  recent.length = 0;
  quietUntil = 0;
  lastSpecificAt = -1;
  lastClickAt = -1;
  lastClick = undefined;
  random = source;
}

function deal(state: SoundState): number {
  if (state.deck.length === 0) {
    const round = Array.from({ length: SFX_TAKES }, (_, k) => k);
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [round[i], round[j]] = [round[j], round[i]];
    }
    if (round[0] === state.lastTake) [round[0], round[round.length - 1]] = [round[round.length - 1], round[0]];
    state.deck.push(...round);
  }
  state.lastTake = state.deck.shift() ?? 0;
  return state.lastTake;
}

/**
 * Plays `name` at `volume` times its own level (1 as balanced) and `pitch` (0.5 to 2), with the mod's variation
 * unless `vary` is false. Returns what played, or undefined when it was dropped.
 */
export function playSfx(name: SfxName, volume = 1, pitch = 1, vary = true): SfxPlay | undefined {
  if (typeof window === "undefined" || typeof performance === "undefined") return undefined;
  const gain = soundGain();
  if (gain <= 0) return undefined;
  const now = performance.now();
  if (now < quietUntil || hurried()) return undefined;
  if (typeof document !== "undefined" && document.hidden) return undefined;
  if (name === "ui.click") {
    if (lastSpecificAt >= 0 && now - lastSpecificAt < SAME_ACTION_MS) return undefined;
  } else if (name !== "ui.tick") {
    lastSpecificAt = now;
    // The click this action already made gives way.
    if (lastClick && now - lastClickAt < SAME_ACTION_MS) {
      stopVoice(lastClick);
      lastClick = undefined;
    }
  }
  let state = states.get(name);
  if (!state) {
    state = { lastAt: -1, streak: 0, deck: [], lastTake: -1 };
    states.set(name, state);
  }
  if (state.lastAt >= 0 && now - state.lastAt < SAME_MS) return undefined;
  state.streak = vary && state.lastAt >= 0 && now - state.lastAt < REPEAT_MS ? state.streak + 1 : 0;
  state.lastAt = now;
  const duck = Math.pow(DUCK, Math.min(state.streak, DUCK_FLOOR));
  const step = vary ? Math.pow(2, PITCH_STEPS[Math.floor(random() * PITCH_STEPS.length)] / 12) : 1;
  const p = Math.max(0.5, Math.min(2, onScale(pitch * step)));
  const loud = Math.pow(10, ((random() * 2 - 1) * LOUDNESS_DB) / 20);
  const take = deal(state) + 1;
  const level = Math.min(1, SFX_BASE * gain * volume * duck * loud);
  const voice = startVoice(sfxUrl(name, take), level, p, name === "ui.click" ? CLICK_AHEAD_S : 0);
  if (name === "ui.click") {
    lastClick = voice;
    lastClickAt = now;
  }
  const play: SfxPlay = { at: now, name, take, volume: level, pitch: p };
  recent.push(play);
  if (recent.length > 60) recent.shift();
  for (const listener of listeners) listener(play);
  return play;
}

/** A note of a run climbing the scale: `degree` notes up from the plain pitch (`Sfx.playDegree`). */
export function playSfxDegree(name: SfxName, volume: number, degree: number): void {
  const notes = SCALE.length - 1;
  const semis = 12 * Math.floor(degree / notes) + SCALE[((degree % notes) + notes) % notes];
  playSfx(name, volume, Math.pow(2, semis / 12), false);
}

/** One rung of a ladder: `step` rungs of `ratio` up from `base` (`Sfx.playStep`). */
export function playSfxStep(name: SfxName, step: number, base: number, ratio: number): void {
  playSfx(name, 1, base * Math.pow(ratio, step));
}

/** Anything pressed (`Hyb.click`). */
export function sfxClick(): void {
  playSfx("ui.click");
}

/** A card or drawer selected: the click, softer and higher. */
export function sfxSelect(): void {
  playSfx("ui.click", 0.6, 1.15);
}

/** One wheel step on a value: up a little higher, down a little lower. */
export function sfxTick(up: boolean): void {
  playSfx("ui.tick", 1, up ? 1.12 : 0.9);
}

export type SfxResourceKind = "item" | "fluid" | "power" | "aspect" | undefined;

/** A wire latching in, or a drawer taking a resource, as what it carries (`Sfx.connect`). */
export function sfxConnect(kind: SfxResourceKind): void {
  playSfx(kind === "power" ? "wire.power" : kind === "fluid" ? "wire.fluid" : "wire.item");
}

/** A wire cut, as what it carried (`Sfx.cut`). */
export function sfxCut(kind: SfxResourceKind): void {
  playSfx(kind === "power" ? "wire.power_cut" : kind === "fluid" ? "wire.fluid_cut" : "wire.cut");
}

/** A voltage tier stepped to, ULV (0) low to MAX high (`Sfx.tier`). */
export function sfxTier(tier: number): void {
  playSfxStep("dial.tier", Math.max(0, tier), 0.62, 1.085);
}

/** Pinned or unpinned: a count, a drawer's rate, a port's rate. */
export function sfxPin(pinned: boolean): void {
  playSfx(pinned ? "board.pin" : "board.unpin");
}

export function sfxToggle(on: boolean): void {
  playSfx(on ? "ui.toggle_on" : "ui.toggle_off");
}

// Edits that sound for themselves ---------------------------------------------

let claimedAt = -1;

/**
 * Says the edit about to land (or that just landed) already made its own sound (undo, clone, a tier chip), so the
 * plan watcher stays quiet for it.
 */
export function claimEdit(): void {
  if (typeof performance !== "undefined") claimedAt = performance.now();
}

/** Whether an edit was claimed within the same action as `at` (80 ms either side). */
export function editClaimedNear(at: number): boolean {
  return claimedAt >= 0 && Math.abs(claimedAt - at) < SAME_ACTION_MS;
}

/** Plays the sound of an edit and claims it. */
export function playEditSfx(name: SfxName, volume = 1, pitch = 1): void {
  claimEdit();
  playSfx(name, volume, pitch);
}

/** A card cloned: its own sound, not a card landing. */
export function cloneWithSound(clone: (id: string) => void, id: string): void {
  playEditSfx("board.clone");
  clone(id);
}
