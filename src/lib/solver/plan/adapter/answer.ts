import { sectionOwnerId } from "../../../model/shared-machine";
import { compareIds } from "../ids";
import { makeLeftoverKey } from "../port-key";
import type {
  Alternative,
  Alternatives,
  Answer,
  DrawerReadout,
  External,
  Id,
  Leftover,
  Note,
  PlanForced,
  PlanBearer,
  PlanLeftover,
  PlanShortfall,
  PlanSide,
  PlanSolveExtras,
  PlanSpill,
  PlanTerminal,
  PlanUpTo,
  PlanUpToLoop,
  PortKey,
  PortRef,
  Shortfall,
  UpToLoop,
  UpToReadout,
} from "../types";
import type { PlanModel } from "./model";

/** The solver's answer in the website's terms. */
export interface PlanReading {
  solved: boolean;
  /** Machine count the answer asks of each solve node (all 0 when it failed). */
  counts: Map<Id, number>;
  /** Flow of each of the project's wires, per second. */
  edgeFlows: Map<string, number>;
  extras: PlanSolveExtras;
}

const EMPTY_DRAWERS: DrawerReadout = { rates: {}, unmet: [], shortfalls: [], ports: {} };

/** Rates below this share of the port's own rate are solver dust. */
const DUST = 1e-9;

const CHOICE_NOTES: ReadonlySet<Note["message"]> = new Set([
  "CHOICE_NO_LONGER_FITS",
  "CHOICE_NEEDS_MORE_GATES",
  "SHOWING_CLOSEST",
  "STOPPED_EARLY",
]);

export function readAnswer(model: PlanModel, answer: Answer): PlanReading {
  const edgeFlows = new Map<string, number>();
  const counts = new Map<Id, number>();

  if (answer.kind === "failed") {
    for (const edge of model.edges) {
      for (const id of model.covers.get(edge.id) ?? [edge.id]) {
        edgeFlows.set(id, 0);
      }
    }
    return {
      solved: false,
      counts,
      edgeFlows,
      extras: {
        forced: [],
        leftovers: [],
        unneeded: [],
        unanchored: model.unanchored,
        terminals: [],
        notes: [...answer.notes],
        openGates: 0,
        failure: answer.failure,
        unmetDrawers: [...answer.drawers.unmet],
      },
    };
  }

  const { solution, alternatives } = answer;
  for (const entry of model.machines.values()) {
    counts.set(entry.id, Math.max(0, solution.machineCounts[entry.id] ?? 0));
  }

  // Wires between machines: the engine's own flows.
  const wired = new Map<string, number>();
  const flowOf = new Map<string, number>();
  for (const [id, { edge, source, target }] of model.engineEdges) {
    const flow = Math.max(0, solution.edgeFlowsPerSecond[id] ?? 0);
    flowOf.set(id, flow);
    wired.set(`${edge.source}|o|${source.index}`, (wired.get(`${edge.source}|o|${source.index}`) ?? 0) + flow);
    wired.set(`${edge.target}|i|${target.index}`, (wired.get(`${edge.target}|i|${target.index}`) ?? 0) + flow);
  }

  // Wires on a buffer: what the solver moved through the buffer at that port.
  const bufferPorts = solution.drawers?.ports ?? {};
  for (const link of model.drawerEdges.values()) {
    const through = bufferPorts[link.drawerId];
    if (!through) continue;
    const at = through.find(
      (e) => e.port.node === link.ref.node && e.port.port === link.ref.port && e.port.input === link.ref.input,
    );
    flowOf.set(link.edgeId, Math.max(0, at?.ratePerSecond ?? 0));
  }

  // Wires to drawers: what the port makes (or takes) that its other wires do
  // not carry. A port has one drawer; should it have more, the first (by id)
  // takes it all.
  const taken = new Map<string, number>();
  for (const link of [...model.drawerEdges.values()].sort((a, b) => compareIds(a.edgeId, b.edgeId))) {
    if (bufferPorts[link.drawerId]) continue;
    const entry = model.machines.get(link.ref.node)!;
    const row = (link.ref.input ? entry.inputs : entry.outputs)[link.ref.port]!;
    const extent = solution.extentsPerSecond[entry.id] ?? 0;
    const rate = extent * row.amount * entry.throughputFactor;
    const portId = `${entry.id}|${link.ref.input ? "i" : "o"}|${link.ref.port}`;
    const rest = rate - (wired.get(portId) ?? 0) - (taken.get(portId) ?? 0);
    const flow = rest > DUST * Math.max(1, rate) ? rest : 0;
    taken.set(portId, (taken.get(portId) ?? 0) + flow);
    flowOf.set(link.edgeId, flow);
  }

  // Each of the player's wires carries what the (joined) wires it stands for carry.
  for (const [flatId, flow] of flowOf) {
    for (const original of model.covers.get(flatId) ?? [flatId]) {
      edgeFlows.set(original, (edgeFlows.get(original) ?? 0) + flow);
    }
  }

  const external = (list: External[], side: "in" | "out") =>
    list
      .filter((e) => !model.hidden.has(e.port.node))
      .flatMap((e): Array<{ node: Id; portKey: PortKey; resourceKey: string; perSecond: number; side: "in" | "out" }> => {
        const row = model.row(e.port);
        return row
          ? [{ node: e.port.node, portKey: row.portKey, resourceKey: row.key, perSecond: e.ratePerSecond, side }]
          : [];
      });

  // A drawer on a port claims what crosses there, so the port shows the drawer's row.
  const forced: PlanForced[] = [
    ...external(solution.gatedSources, "in"),
    ...external(solution.gatedSinks, "out"),
  ]
    .filter((e) => !model.drawerPorts.has(e.portKey))
    .map((e) => ({
      nodeId: e.node,
      portKey: e.portKey,
      side: e.side,
      resourceKey: e.resourceKey,
      perSecond: e.perSecond,
    }));

  // What a maker puts into a buffer beyond what its takers take: the maker's forced row, totalled on the buffer.
  const spills: PlanSpill[] = Object.entries(solution.drawers?.spills ?? {}).flatMap(([drawerId, list]) =>
    external(list, "out")
      .filter((e) => e.perSecond > DUST)
      .map((e) => ({
        nodeId: e.node,
        portKey: e.portKey,
        resourceKey: e.resourceKey,
        perSecond: e.perSecond,
        drawerId,
      })),
  );

  // An unwired port with a drawer on it is that drawer's, not a free terminal.
  const terminals: PlanTerminal[] = [
    ...external(solution.terminalInputs, "in"),
    ...external(solution.terminalOutputs, "out"),
  ]
    .filter((e) => !model.drawerPorts.has(e.portKey))
    .map((e) => ({
      nodeId: e.node,
      portKey: e.portKey,
      side: e.side,
      resourceKey: e.resourceKey,
      perSecond: e.perSecond,
    }));

  const leftovers = solution.spares.flatMap((spare) => readLeftover(model, spare, alternatives));
  // A forced row finds its decision through what crosses at the places' gates (a stored split puts flow at
  // more than one place; every one of them is the same decision).
  const decisionOfPort = new Map<PortKey, PortKey>();
  for (const leftover of leftovers) {
    if (leftover.decision === undefined) {
      continue;
    }
    for (const bearer of leftover.bearers) {
      for (const place of bearer.whole ?? []) {
        decisionOfPort.set(place.portKey, leftover.decision);
      }
      for (const flow of bearer.flows) {
        decisionOfPort.set(flow.portKey, leftover.decision);
      }
    }
  }
  for (const row of forced) {
    const decision = decisionOfPort.get(row.portKey);
    if (decision !== undefined) {
      row.decision = decision;
    }
  }

  const upTo = readUpTo(model, solution.upTo ?? []);
  const loops = readLoops(model, solution.upToLoops ?? []);
  const shortfalls = readShortfalls(model, (solution.drawers ?? EMPTY_DRAWERS).shortfalls);
  const unneeded = solution.unneeded.filter((id) => model.machines.has(id) && !model.hidden.has(id));
  const notes: Note[] = [...solution.notes, ...alternatives.notes];
  const choiceNotes = notes.filter((n) => CHOICE_NOTES.has(n.message));
  const anchorKeys = (refs: PortRef[]): PortKey[] =>
    refs.flatMap((ref) => {
      const row = model.row(ref);
      return row ? [row.portKey] : [];
    });

  return {
    solved: true,
    counts,
    edgeFlows,
    extras: {
      ...(Object.keys(upTo).length > 0 ? { upTo } : {}),
      ...(loops.length > 0 ? { loops } : {}),
      ...(shortfalls.length > 0 ? { shortfalls } : {}),
      forced,
      ...(spills.length > 0 ? { spills } : {}),
      leftovers,
      unneeded,
      unanchored: model.unanchored,
      terminals,
      notes,
      openGates: solution.openGates,
      unmetDrawers: (solution.drawers ?? EMPTY_DRAWERS).unmet,
      chosen: anchorKeys(alternatives.chosen?.gateAnchors ?? solution.key.gateAnchors),
      alternativesComplete: alternatives.complete,
      choiceNotes,
    },
  };
}

/** The Up to read-outs by CARD id: a shared card's whole pool is one entry under the card's id. */
export function readUpTo(model: PlanModel, readouts: readonly UpToReadout[]): Record<Id, PlanUpTo> {
  const cardOf = (id: Id): Id => model.machines.get(id)?.owner ?? sectionOwnerId(id);
  const rowOf = (ref: PortRef) => model.row(ref);
  const out: Record<Id, PlanUpTo> = {};
  for (const r of readouts) {
    const card = cardOf(r.node);
    const row = r.port ? rowOf(r.port) : undefined;
    const tied = (r.tied ?? []).flatMap((ref) => {
      const tiedRow = rowOf(ref);
      return tiedRow ? [tiedRow.portKey] : [];
    });
    const upstream = [...new Set((r.upstream ?? []).map(cardOf))];
    out[card] = {
      capacity: r.capacity,
      reached: r.reached,
      reason: r.reason,
      ...(row ? { portKey: row.portKey, resourceKey: row.key } : {}),
      ...(tied.length > 0 ? { tied } : {}),
      ...(r.wants !== undefined ? { wants: r.wants } : {}),
      ...(upstream.length > 0 ? { upstream } : {}),
    };
  }
  return out;
}

/** The Up to rings with cards for nodes (once each), rows for ports and their resources (once each). */
export function readLoops(model: PlanModel, loops: readonly UpToLoop[]): PlanUpToLoop[] {
  const cardOf = (id: Id): Id => model.machines.get(id)?.owner ?? sectionOwnerId(id);
  return loops.map((loop) => {
    const rows = loop.ports.flatMap((ref) => {
      const row = model.row(ref);
      return row ? [row] : [];
    });
    return {
      kind: loop.kind,
      cards: [...new Set(loop.nodes.map(cardOf))],
      portKeys: rows.map((row) => row.portKey),
      resourceKeys: [...new Set(rows.map((row) => row.key))],
    };
  });
}

/** Drawers the answer falls short of, with the limiting machines turned into cards (first seen first, once each). */
export function readShortfalls(model: PlanModel, shortfalls: readonly Shortfall[]): PlanShortfall[] {
  return shortfalls
    .filter((s) => !model.hidden.has(s.drawer))
    .map((s) => ({
      drawerId: s.drawer,
      rule: s.rule,
      target: s.target,
      reachable: s.reachable,
      limitingCards: [
        ...new Set(s.limitingNodes.map((id) => model.machines.get(id)?.owner ?? sectionOwnerId(id))),
      ],
      limitingDrawers: [...s.limitingDrawers],
    }));
}

function readLeftover(model: PlanModel, spare: Leftover, alternatives: Alternatives): PlanLeftover[] {
  const pick = spare.bearers.find((b) => b.solverPick) ?? spare.bearers[0];
  const pickRow = pick ? model.row(pick.anchor) : undefined;
  const sideOf = (ref: PortRef): PlanSide => (ref.input ? "in" : "out");
  const bearers: PlanBearer[] = [];
  for (const bearer of spare.bearers) {
    const row = model.row(bearer.anchor);
    if (!row) {
      return [];
    }
    // The search's option this place is: the same decision, opening this gate.
    const option: Alternative | undefined = alternatives.options.find(
      (o) => samePort(o.opens, bearer.anchor) && pick !== undefined && samePort(o.replaces, pick.anchor),
    );
    bearers.push({
      portKey: row.portKey,
      maxPerSecond: bearer.max,
      share: bearer.share,
      solverPick: bearer.solverPick,
      flows: bearer.flows.flatMap((flow) => {
        const flowRow = model.row(flow.port);
        return flowRow ? [{ portKey: flowRow.portKey, perSecond: flow.ratePerSecond }] : [];
      }),
      nodeId: bearer.anchor.node,
      side: sideOf(bearer.anchor),
      resourceKey: row.key,
      ...(option
        ? {
            rank: option.rank,
            whole: option.externals.flatMap((e) => {
              const r = model.row(e.port);
              return r ? [{ portKey: r.portKey, side: sideOf(e.port), perSecond: e.ratePerSecond }] : [];
            }),
            support: option.key.gateAnchors.flatMap((a) => {
              const r = model.row(a);
              return r ? [r.portKey] : [];
            }),
          }
        : {}),
    });
  }
  if (bearers.length === 0) {
    return [];
  }
  const split: Record<PortKey, number> = {};
  const defaultSplit: Record<PortKey, number> = {};
  for (const b of bearers) {
    split[b.portKey] = b.share;
    defaultSplit[b.portKey] = b.solverPick ? 1 : 0;
  }
  return [
    {
      key: makeLeftoverKey(bearers.map((b) => b.portKey)),
      importing: spare.importing,
      custom: spare.custom,
      bearers,
      ...(pickRow ? { decision: pickRow.portKey, resourceKey: pickRow.key } : {}),
      split,
      defaultSplit,
    },
  ];
}

function samePort(a: PortRef, b: PortRef): boolean {
  return a.node === b.node && a.port === b.port && a.input === b.input;
}
