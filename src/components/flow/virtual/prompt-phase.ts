/**
 * Every pulsing prompt on the board ("(set count)", "Set rate") blinks off ONE clock: a timer flips
 * `data-cc-blink` on the root element twice a second and the prompts' colour follows it in CSS
 * (clean.css, drawer.css, interaction.css). A CSS animation per prompt kept the page drawing at 60 frames a second
 * and restyling every frame for as long as one prompt was on the board (131 recalcs in a 2 s idle at 200 cards);
 * the clock costs two small restyles a second, of the prompts alone (the root's attribute is matched only by the
 * prompts' own selectors), and none while no prompt is mounted. The phase is the document timeline's, as the
 * animations' was: gold for the first half of each second, grey for the second.
 *
 * The acceptance glow (a wire in hand) is still a CSS animation; the ones that start late are pinned to the
 * shared phase by one `document.getAnimations()` a frame, never a subtree walk per card.
 */
const PULSES = new Set(["cc-accept", "cc-glow"]);

/** The attribute on the root element while the prompts are in their grey half. */
export const BLINK_ATTRIBUTE = "data-cc-blink";
/** One whole blink (gold then grey), as `--cc-prompt` says in clean.css. */
export const BLINK_MS = 1000;
/**
 * Everything that blinks off the clock: the prompts, the outline of a card in a dead loop or a clog lock, and that
 * ring's notice (its cards may be off screen, unmounted).
 */
const PROMPTS =
  ".cc-count[data-prompt], .cc-prb[data-prompt], .cd-box[data-prompt], .cc-card[data-loop], .rail-notice[data-alarm]";

let frame = 0;
let clock: ReturnType<typeof setTimeout> | undefined;

function flush() {
  frame = 0;
  // (jsdom has no Web Animations.)
  if (typeof document.getAnimations !== "function") return;
  for (const animation of document.getAnimations()) {
    const name = (animation as CSSAnimation).animationName;
    if (name && PULSES.has(name) && animation.startTime !== 0) animation.startTime = 0;
  }
}

/** Whether the prompts are in their grey half at this time (document time, ms). */
export function blinkOffAt(now: number): boolean {
  return now % BLINK_MS >= BLINK_MS / 2;
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function tick() {
  clock = undefined;
  const root = document.documentElement;
  const now = performance.now();
  if (!document.querySelector(PROMPTS)) {
    // Nothing prompts: the clock stops until a prompt mounts again (syncPromptPhase).
    if (root.hasAttribute(BLINK_ATTRIBUTE)) root.removeAttribute(BLINK_ATTRIBUTE);
    return;
  }
  // Reduced motion: the prompts keep one colour (each prompt's own CSS says which).
  const off = blinkOffAt(now) && !reducedMotion();
  if (off !== root.hasAttribute(BLINK_ATTRIBUTE)) root.toggleAttribute(BLINK_ATTRIBUTE, off);
  const half = BLINK_MS / 2;
  clock = setTimeout(tick, half - (now % half) + 1);
}

/** Starts the prompts' clock if it is not running (it stops itself when no prompt is left). */
export function startPromptClock(): void {
  // (Not in jsdom, which has no Web Animations: a test's fake timers would run it for ever.)
  if (
    clock !== undefined ||
    typeof document === "undefined" ||
    typeof document.getAnimations !== "function"
  )
    return;
  clock = setTimeout(tick, 0);
}

/** Pins the acceptance glows on the page to the shared phase, in the next frame. */
export function queuePhaseSync(): void {
  if (!frame && typeof document !== "undefined") frame = requestAnimationFrame(flush);
}

/** A card that shows a prompt: the clock runs (every prompt shares its phase). */
export function syncPromptPhase(): void {
  startPromptClock();
}
