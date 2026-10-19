/**
 * The zoomed-out face (`.cc-glance`, one element): the card's picture and count, and along its foot the Up to bar, so
 * how hard each machine runs reads at a glance. The bar is two background layers over the picture (the fill in the
 * reason's tone, the track under it), the reason's word is the element's own text, sized in card pixels so a zoom
 * re-lays nothing out. Pure.
 */
import type { CSSProperties } from "react";
import type { PlanUpTo } from "@/lib/solver/plan/types";
import type { FootTone } from "./clean-model";
import { LOOP_WORD, type LoopTone } from "./loops";
import { artRatio } from "@/lib/power/structure-art-ratios";

/** The bar a zoomed-out face draws: how full (0 to 1), in which tone, and the reason's word (empty for none). */
export interface GlanceBar {
  tone: FootTone;
  fill: number;
  word: string;
}

const TONE: Record<NonNullable<PlanUpTo["reason"]>, FootTone> = {
  FULL: "full",
  BOTTLENECK: "bottleneck",
  STARVED: "starved",
  CLOGGED: "clogged",
  UNUSED: "unused",
  LIMITED: "limited",
};

/**
 * An Up to card's bar at a glance, from its read-out: filled to what runs over the count (a bottleneck's over what
 * the line wants, as the card's own bar). None for a card that is not Up to. A card in a ring (`loop`) says DEAD LOOP
 * or CLOG LOCK in the ring's tone, as its own bar does.
 */
export function glanceBar(upTo: PlanUpTo | undefined, loop?: LoopTone): GlanceBar | undefined {
  if (!upTo) return undefined;
  const capacity = upTo.capacity;
  const wants =
    upTo.reason === "BOTTLENECK" && upTo.wants !== undefined && upTo.wants > capacity
      ? upTo.wants
      : undefined;
  const end = wants ?? capacity;
  const fill = end > 0 ? Math.min(1, Math.max(0, upTo.reached / end)) : 0;
  if (loop) return { tone: loop === "dead" ? "starved" : "clogged", fill, word: LOOP_WORD[loop] };
  return { tone: upTo.reason ? TONE[upTo.reason] : "plain", fill, word: upTo.reason ?? "" };
}

/** The glance layer's attributes: its picture (a CSS image, `url(...)`), and the bar along its foot when it has one. */
export function glanceFace(
  art: string | undefined,
  bar: GlanceBar | undefined,
): { style: CSSProperties | undefined; "data-bar"?: ""; "data-tone"?: FootTone; text: string } {
  if (!bar) return { style: art ? { backgroundImage: art } : undefined, text: "" };
  const layers = [
    "linear-gradient(var(--glance-fill-ink), var(--glance-fill-ink))",
    "linear-gradient(var(--glance-track), var(--glance-track))",
    ...(art ? [art] : []),
  ];
  // The picture's width over its height, so it stays whole over the bar however tall the card (clean.css).
  const ratio = artRatio(art?.match(/^url\(["']?(.*?)["']?\)$/)?.[1]);
  return {
    style: {
      backgroundImage: layers.join(", "),
      ["--glance-fill" as string]: `${Math.round(bar.fill * 1000) / 10}%`,
      ...(ratio !== 1 ? { ["--glance-art-ratio" as string]: String(ratio) } : {}),
    } as CSSProperties,
    "data-bar": "",
    "data-tone": bar.tone,
    text: bar.word,
  };
}
