/**
 * Old Build's dead loops and clog locks on a plan board (`PlanSolveExtras.loops`, docs/up-to.md): which cards are in a
 * ring, which wires join them along the ring's rows, and what the notice says. Pure.
 */
import type { FactoryEdge } from "@/lib/model/types";
import { sectionNodeId, splitSectionHandleId } from "@/lib/model/shared-machine";
import { makePortKey } from "@/lib/solver/plan/port-key";
import type { PlanUpToLoop } from "@/lib/solver/plan/types";

/** A ring's look on the board: a dead loop in STARVED's amber, a clog lock in CLOGGED's purple. */
export type LoopTone = "dead" | "clog";

export function loopTone(loop: Pick<PlanUpToLoop, "kind">): LoopTone {
  return loop.kind === "DEAD_LOOP" ? "dead" : "clog";
}

/** What a ring is called: its notice's tag, and the word on each of its cards' foot bars in place of the reason. */
export const LOOP_WORD: Record<LoopTone, string> = { dead: "DEAD LOOP", clog: "CLOG LOCK" };

/** The ring a card is in (the first, when it is in several), as its tone. */
export function cardLoop(
  loops: readonly PlanUpToLoop[] | undefined,
  cardId: string,
): LoopTone | undefined {
  const loop = loops?.find((entry) => entry.cards.includes(cardId));
  return loop ? loopTone(loop) : undefined;
}

/** A wire end's port key, as the solve names it (a shared machine's recipe is its own solve node). */
function endKey(nodeId: string, side: "i" | "o", handle: string | undefined): string | undefined {
  if (!handle) return undefined;
  const split = splitSectionHandleId(handle);
  return makePortKey(sectionNodeId(nodeId, split.section), side, split.handleId ?? handle);
}

/**
 * The wires that join a ring's cards along its rows: both ends on the ring's cards, and one end on a row the ring
 * names (its members' blaming ports: a dead loop's inputs, a clog lock's outputs). By wire id, the ring's tone.
 */
export function loopEdges(
  edges: readonly Pick<FactoryEdge, "id" | "source" | "target" | "sourceHandle" | "targetHandle">[],
  loops: readonly PlanUpToLoop[] | undefined,
): Map<string, LoopTone> {
  const out = new Map<string, LoopTone>();
  for (const loop of loops ?? []) {
    const cards = new Set(loop.cards);
    const rows = new Set(loop.portKeys);
    for (const edge of edges) {
      if (out.has(edge.id) || !cards.has(edge.source) || !cards.has(edge.target)) continue;
      const from = endKey(edge.source, "o", edge.sourceHandle ?? undefined);
      const to = endKey(edge.target, "i", edge.targetHandle ?? undefined);
      if ((from && rows.has(from)) || (to && rows.has(to))) out.set(edge.id, loopTone(loop));
    }
  }
  return out;
}

/** What a ring is: the tag its notice wears in front of its sentence, in the ring's tone and blinking. */
export function loopTag(loop: Pick<PlanUpToLoop, "kind">): string {
  return LOOP_WORD[loopTone(loop)];
}

/**
 * The notice for a ring after its tag, one short sentence: its cards starve (a dead loop) or clog (a clog lock) each
 * other in a downward spiral, each holding the next back. Which cards is for Show me, their pulsing outlines and the
 * lit wires to say; `cards` is how many.
 */
export function loopSentence(loop: Pick<PlanUpToLoop, "kind">, cards: number): string {
  const dead = loop.kind === "DEAD_LOOP";
  if (cards === 1) return `This machine ${dead ? "starves" : "clogs"} itself in a downward spiral.`;
  return `These machines ${dead ? "starve" : "clog"} each other in a downward spiral.`;
}
