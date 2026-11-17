/**
 * The public entry of the plan solver (spec-solver 0, 3.4, 3.9.3, 5; Java `Balancer.solveWithAlternatives`): islands,
 * each solved by the full chain (drawer relaxation, stored choice, alternatives, spares) with island-local indexing, then
 * merged into one `SolutionView` + `Alternatives` read over the whole plan; each island's Up to read-out is its own
 * (docs/up-to.md). A pure function: same input, same output.
 */
import { inputDigest, type PieceCache } from "./cache";
import { SolveContext, type StageOutcome } from "./context";
import { applyChoice, enumerate } from "./enumerate";
import { splitIslands } from "./islands";
import { compareIds, comparePortRef } from "./ids";
import { portKey } from "./model";
import { drawerRelaxation } from "./relax";
import { applySpares } from "./spares";
import { buildSolutionView, solvePiece, type CoreExtensions, type Piece } from "./solve-core";
import { DISPLAY_ORDER, compareKeys } from "./enumerate";
import type {
  Alternative,
  Answer,
  Leftover,
  Note,
  PortRef,
  SolveInput,
  UpToLoop,
  UpToReadout,
} from "./types";

/** The extensions WP1c adds to the core: drawer relaxation, and after the point is committed the choice, the search and the spares. */
export const planExtensions: CoreExtensions = {
  relax: drawerRelaxation,
  finish: (ctx) => {
    const choice = ctx.input.choice;
    if (choice) ctx.commit(applyChoice(ctx, choice));
    const points = new Map<string, StageOutcome>();
    const alternatives = enumerate(ctx, points);
    const spares = applySpares(ctx, alternatives, points, ctx.input.spares);
    return { alternatives, spares };
  },
};

/** The place the solver itself put a leftover: the decision it is listed under. */
function decisionOf(leftover: Leftover): PortRef {
  for (const b of leftover.bearers) if (b.solverPick) return b.anchor;
  return leftover.bearers[0]!.anchor;
}

function portOf(whole: SolveContext, ref: PortRef): number {
  return whole.model.portLookup.get(
    portKey(whole.model.machineIndex.get(ref.node)!, ref.port, ref.input),
  )!;
}

/**
 * The plan's answer: every island solved by itself, read together as one plan's. With a `cache` an island whose input
 * was solved before (by value) is read back, not solved again; the answer is the same either way.
 */
export function solvePlan(
  input: SolveInput,
  ext: CoreExtensions = planExtensions,
  cache?: PieceCache,
): Answer {
  const solveIsland = (island: SolveInput): Piece => {
    if (!cache) return solvePiece(island, ext);
    const key = inputDigest(island);
    const kept = cache.get(key);
    if (kept) return kept;
    const piece = solvePiece(island, ext);
    cache.set(key, piece);
    return piece;
  };
  const islands = splitIslands(input);
  if (islands.length === 1) return solveIsland(input).answer;
  // Read every retained answer before inserting any misses that could evict it.
  const pieces: Piece[] = cache
    ? islands.map((island) => {
        const key = inputDigest(island);
        return { island, key, piece: cache.get(key) };
      }).map(({ island, key, piece }) => {
        if (piece) return piece;
        const solved = solvePiece(island, ext);
        cache.set(key, solved);
        return solved;
      })
    : islands.map((island) => solvePiece(island, ext));
  if (!pieces.some((p) => p.answer.kind === "solved")) return solveIsland(input).answer;

  const whole = new SolveContext(input);
  const model = whole.model;
  const extents = new Array<number>(model.machines.length).fill(0);
  const flows = new Array<number>(model.edges.length).fill(0);
  const externals = new Array<number>(model.connectedPorts.length).fill(0);
  const edgeIndex = new Map<string, number>();
  model.edges.forEach((e, i) => {
    if (!edgeIndex.has(e.id)) edgeIndex.set(e.id, i);
  });
  const support = new Set<number>();
  const options: Alternative[] = [];
  const choiceNotes: Note[] = [];
  const spares: Leftover[] = [];
  const upTo: UpToReadout[] = [];
  const upToLoops: UpToLoop[] = [];
  let complete = true;
  for (const piece of pieces) {
    const c = piece.ctx;
    const answer = piece.answer;
    if (answer.kind === "failed") {
      // An island with nothing to size is idle, not broken; any other stands unsolved, and says why.
      if (answer.failure.message !== "NO_PIN") {
        whole.stageNotes.push(answer.failure);
        whole.stageNotes.push(
          ...answer.notes.slice(Math.min(c.constructionNotes, answer.notes.length)),
        );
      }
      continue;
    }
    const point = c.point!;
    c.model.machines.forEach((md, m) => {
      extents[model.machineIndex.get(md.spec.id)!] = point.extents[m]!;
    });
    c.model.edges.forEach((e, i) => {
      flows[edgeIndex.get(e.id)!] = point.flows[i]!;
    });
    for (let q = 0; q < c.model.connectedPorts.length; q++)
      externals[portOf(whole, c.refOf(q))] = point.externals[q]!;
    for (const g of point.support) {
      support.add(model.portGate[portOf(whole, c.refOf(c.model.gates[g]!.ports[0]!))]!);
    }
    whole.stageNotes.push(...c.notes.slice(c.constructionNotes));
    whole.stageNotes.push(...c.stageNotes);
    for (const id of c.unmetDrawers)
      if (!whole.unmetDrawers.includes(id)) whole.unmetDrawers.push(id);
    whole.shortfalls.push(...c.shortfalls);
    options.push(...answer.alternatives.options);
    choiceNotes.push(...answer.alternatives.notes);
    complete &&= answer.alternatives.complete;
    spares.push(...answer.solution.spares);
    upTo.push(...(answer.solution.upTo ?? []));
    upToLoops.push(...(answer.solution.upToLoops ?? []));
  }
  whole.commit(whole.outcome(extents, flows, externals, support));
  // Each option keeps its island's key: a stored choice applies to the islands its anchors sit on.
  const planOptions = options
    .slice()
    .sort(
      (a, b) =>
        comparePortRef(a.replaces, b.replaces) ||
        DISPLAY_ORDER.indexOf(a.rank) - DISPLAY_ORDER.indexOf(b.rank) ||
        compareKeys(a.key, b.key),
    );
  spares.sort((a, b) => comparePortRef(decisionOf(a), decisionOf(b)));
  upTo.sort((a, b) => compareIds(a.node, b.node));
  upToLoops.sort((a, b) => compareIds(a.nodes[0]!, b.nodes[0]!));
  const solution = buildSolutionView(whole, spares, upTo.length > 0 ? upTo : undefined, upToLoops);
  return {
    kind: "solved",
    solution,
    alternatives: {
      chosen: whole.keyOf(support),
      options: planOptions,
      complete,
      notes: choiceNotes,
    },
  };
}
