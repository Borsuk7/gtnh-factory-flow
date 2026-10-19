"use client";

import { useMemo } from "react";
import { useFactoryStore } from "@/store/factory-store";
import type { FactoryNode } from "@/lib/model/types";
import { pinRuleOf } from "@/lib/model/pin-rule";
import {
  cardCountState,
  cardPicture,
  deriveCardFace,
  formatSolvedMachines,
  stateFrameTone,
} from "../clean/clean-model";
import { CC_GEOMETRY } from "../clean/tokens";
import { cardLoop, type LoopTone } from "../clean/loops";
import { glanceBar, type GlanceBar } from "../clean/glance";
import { useDeviceSettings } from "@/lib/device-settings";
import { estimateRecipeCardHeight } from "./card-shell";
import { useMachineHandlerIconEntries, useRecipeMapIcons } from "../machine-icons";
import type { RecipeNodeData } from "../RecipeNode";

/**
 * What a shell knows about its card, without running the card's model.
 *
 * The card's model (clean-model.ts) builds the rails against the whole project (every wire, every drawer, the
 * verdict) for each card on every solve: O(cards x wires) a tick. A shell needs only its face (the count, the
 * picture, the red ring, the "set count" mark), and a key for whether its layout could have changed since it was
 * last drawn, so that a card whose rows moved while it was away is drawn again in the background pass.
 */

/** What a shell paints. */
export interface ShellFace {
  selected: boolean;
  cannotRun: boolean;
  unset: boolean;
  /** A problem card's frame tone (clean-model `stateFrameTone`), as the card wears it. */
  tone?: string;
  /** The card is in a dead loop or a clog lock: its outline pulses in the ring's tone, as the card's does. */
  loop?: LoopTone;
  /** The Up to bar along the glance face's foot, as the card's own glance face draws it. */
  bar?: GlanceBar;
  /** The count the glance face prints. */
  count: string;
  /** The picture the glance face draws. */
  art?: string;
  /** The box to use when React Flow has not measured the card yet. */
  fallbackWidth: number;
  fallbackHeight: number;
}

const FLOW_EPSILON = 1e-6;

/** The card's own data apart from where it sits and what is pinned (neither moves a row). */
const nodeKeys = new WeakMap<FactoryNode, string>();
export function stableNodeKey(node: FactoryNode): string {
  let key = nodeKeys.get(node);
  if (key === undefined) {
    key = JSON.stringify(node, (name, value) =>
      name === "position" || name === "solvePin" ? undefined : value,
    );
    nodeKeys.set(node, key);
  }
  return key;
}

const pinsKeys = new WeakMap<object, string>();
function pinsKey(pins: unknown): string {
  if (!pins || typeof pins !== "object") return "";
  let key = pinsKeys.get(pins);
  if (key === undefined) {
    key = JSON.stringify(pins);
    pinsKeys.set(pins, key);
  }
  return key;
}

type PlanLike = { forced: Array<{ nodeId: string; portKey: string }> };
const forcedKeys = new WeakMap<object, Map<string, string>>();
function forcedKeyOf(plan: PlanLike | undefined, nodeId: string): string {
  if (!plan) return "";
  let byNode = forcedKeys.get(plan);
  if (!byNode) {
    const grouped = new Map<string, string[]>();
    for (const entry of plan.forced) {
      const list = grouped.get(entry.nodeId);
      if (list) list.push(entry.portKey);
      else grouped.set(entry.nodeId, [entry.portKey]);
    }
    byNode = new Map([...grouped].map(([id, keys]) => [id, keys.sort().join(",")]));
    forcedKeys.set(plan, byNode);
  }
  return byNode.get(nodeId) ?? "";
}

function flowKeys(flows: Record<string, { amountPerSecond: number }> | undefined): string {
  if (!flows) return "-";
  let out = "";
  for (const key in flows) if (flows[key]!.amountPerSecond > FLOW_EPSILON) out += `${key},`;
  return out;
}

/**
 * Everything that can move a card's rows or its box: its data, the settings pins, the flows the solve gives its
 * ports (a port with no flow is not drawn), the forced rows under them, and the count's rule with whether the solve
 * read an Up to card out (the bar along the foot). Over-reporting costs one background redraw; under-reporting is
 * corrected the next time the card is drawn.
 */
export function useCardLayoutKey(data: RecipeNodeData): string {
  const { projectNode, recipe, result } = data;
  const pins = useFactoryStore((state) => pinsKey(state.project.settingPins));
  const forced = useFactoryStore((state) =>
    forcedKeyOf(state.lastResult?.plan as PlanLike | undefined, projectNode.id),
  );
  const readOut = useFactoryStore(
    (state) => state.lastResult?.plan?.upTo?.[projectNode.id] !== undefined,
  );
  const rule = `${pinRuleOf(projectNode, recipe)}${readOut ? "+" : ""}`;
  return `${recipe.id}#${stableNodeKey(projectNode)}#${pins}#${flowKeys(result?.inputs)}|${flowKeys(result?.outputs)}#${forced}#${rule}`;
}

/** The face of a card that is not mounted, and the key for its layout. */
export function useCardFace(
  data: RecipeNodeData,
  selected: boolean,
): { face: ShellFace; layoutKey: string } {
  const { projectNode, recipe, result } = data;
  const machineIcons = useMachineHandlerIconEntries();
  const mapIcons = useRecipeMapIcons();
  const { problemOutlines } = useDeviceSettings();
  const layoutKey = useCardLayoutKey(data);
  const nodeKey = stableNodeKey(projectNode);
  // Keyed on the node's own data, not its identity: an Arrange gives every card a new position and no new machine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const derived = useMemo(() => deriveCardFace(recipe, projectNode), [recipe, nodeKey]);
  const plan = useFactoryStore.getState().lastResult?.plan;
  // What runs: an Up to card's reached count, as the card's own glance face prints it.
  const count = cardCountState(result, projectNode, plan, recipe);
  const { machineIcon, art } = cardPicture(recipe, projectNode, derived, machineIcons, mapIcons);
  const face: ShellFace = {
    selected,
    cannotRun: derived.powerReport !== undefined && derived.powerReport.state !== "ok",
    unset: count.unset,
    tone: problemOutlines ? stateFrameTone(count, plan, projectNode.id) : undefined,
    loop: cardLoop(plan?.loops, projectNode.id),
    bar: glanceBar(count.upTo, cardLoop(plan?.loops, projectNode.id)),
    count: `×${formatSolvedMachines(count.value)}`,
    art: art ?? machineIcon?.iconPath,
    fallbackWidth: CC_GEOMETRY.cardWidth,
    // The first paint of a card nobody has drawn: the rows its recipe would give it, before the solve says which
    // flow and which forced lines it has. The draw measures the real box.
    fallbackHeight: estimateRecipeCardHeight(
      derived.effectiveRecipe,
      derived.powerReport !== undefined,
    ),
  };
  return { face, layoutKey };
}
