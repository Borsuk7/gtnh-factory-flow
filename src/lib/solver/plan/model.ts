/**
 * The plan as the solver sees it, built once per island solve (spec-solver 1.4, 3.1; Java `ModelData`). Indices
 * (machine, edge, connected port, gate, pool, drawer) are part of the answer: the tie weights and the swap order key
 * on them, so nothing here sorts, dedupes through a Set, or renumbers beyond what the spec says.
 */
import { buildGates, portStepsOf, type Gate } from "./gates";
import type { DrawerKind, DrawerRule, EdgeIn, Id, MachineIn, PortRef, SolveInput } from "./types";

export const TICKS_PER_SECOND = 20;

export interface MachineData {
  spec: MachineIn;
  /** Ticks per craft; the spec's `durationTicks <= 0` reads as 1. */
  durTicks: number;
  /** Per-craft quantity of each input/output port: `max(0, amount) * chance * multiplier * throughputFactor`. */
  inQty: number[];
  outQty: number[];
  /** The extent the machine's port rates imply (largest rate/qty wins), 0 when none. */
  targetExtent: number;
  /** `machineCount * 20 / durTicks` when the count is pinned, else null. */
  fixedExtent: number | null;
}

export interface EdgeData {
  id: Id;
  srcPort: number;
  dstPort: number;
}

export interface ConnectedPort {
  machine: number;
  portIndex: number;
  input: boolean;
  qtyPerCraft: number;
  /** Edge indices that touch the port, in edge order. */
  edges: number[];
}

export interface PoolData {
  machines: number[];
  capacity: number;
  exact: boolean;
  /** The Up to rule (docs/up-to.md): a cap the push runs up against, never forced flow. Never with `exact`. */
  upTo: boolean;
}

export interface DrawerRow {
  id: Id;
  label: string;
  kind: DrawerKind;
  rule: DrawerRule;
  rate: number;
  /** Unwired links: machine indices ascending and the summed per-craft quantity. */
  extentMachines: number[];
  extentQty: number[];
  /** Wired links: connected-port indices. */
  externalPorts: number[];
  /** Every valid link, wired or not, in link order (a buffer's makers, then its users). */
  links: PortRef[];
  /** A buffer's edges, whose flows are its total; empty for every other kind (Java `DrawerRow.flowEdges`). */
  flowEdges: number[];
}

export interface ModelData {
  machines: MachineData[];
  machineIndex: Map<Id, number>;
  edges: EdgeData[];
  /** How many of `edges` are the plan's own wires; the buffers' edges come after them (Java `drawnEdges`). */
  drawnEdges: number;
  connectedPorts: ConnectedPort[];
  /** `portKey(machine, portIndex, input)` -> connected-port index. */
  portLookup: Map<number, number>;
  gates: Gate[];
  pools: PoolData[];
  drawers: DrawerRow[];
  portGate: number[];
  portComponent: number[];
  portSteps: number[];
}

/** Lookup key of a machine's port (machine and port counts are far below 2^20 / 2^30). */
export function portKey(machine: number, portIndex: number, input: boolean): number {
  return (machine * 1_073_741_824 + portIndex) * 2 + (input ? 1 : 0);
}

export function drawerLinksInputs(kind: DrawerKind): boolean {
  return kind === "SOURCE";
}

/**
 * A buffer edge's id: the text the Java hashes into a UUID (`ModelData.bufferEdgeId`). Only the island merge reads
 * it, and only within one language, so the text itself serves.
 */
export function bufferEdgeId(
  drawer: Id,
  from: { node: Id; port: number },
  to: { node: Id; port: number },
): Id {
  return `buffer:${drawer}:${from.node}#${from.port}>${to.node}#${to.port}`;
}

function extentFor(targets: Record<number, number>, qty: readonly number[]): number {
  let extent = 0;
  for (const [key, rate] of Object.entries(targets)) {
    if (!(typeof rate === "number") || !(rate > 0)) continue;
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= qty.length || !(qty[i]! > 0)) continue;
    extent = Math.max(extent, rate / qty[i]!);
  }
  return extent;
}

function machineData(spec: MachineIn): MachineData {
  const durTicks = spec.durationTicks > 0 ? spec.durationTicks : 1;
  const tf = spec.throughputFactor;
  const qty = (p: { amount: number; chance: number; multiplier: number }) =>
    Math.max(0, p.amount) * p.chance * p.multiplier * tf;
  const inQty = spec.inputs.map(qty);
  const outQty = spec.outputs.map(qty);
  const target = Math.max(
    extentFor(spec.targetOutputRates, outQty),
    extentFor(spec.targetInputRates, inQty),
  );
  return {
    spec,
    durTicks,
    inQty,
    outQty,
    targetExtent: target > 0 ? target : 0,
    fixedExtent: spec.countFixed ? (spec.machineCount * TICKS_PER_SECOND) / durTicks : null,
  };
}

export function hasPort(m: MachineData, portIndex: number, input: boolean): boolean {
  return (
    Number.isInteger(portIndex) &&
    portIndex >= 0 &&
    portIndex < (input ? m.inQty.length : m.outQty.length)
  );
}

export function buildModel(input: SolveInput): ModelData {
  const machines: MachineData[] = [];
  const machineIndex = new Map<Id, number>();
  for (const spec of input.machines) {
    if (machineIndex.has(spec.id)) continue; // a repeated id keeps the first
    machineIndex.set(spec.id, machines.length);
    machines.push(machineData(spec));
  }

  const edges: EdgeData[] = [];
  const connectedPorts: ConnectedPort[] = [];
  const portLookup = new Map<number, number>();
  const intern = (machine: number, portIndex: number, isInput: boolean): number => {
    const key = portKey(machine, portIndex, isInput);
    let p = portLookup.get(key);
    if (p === undefined) {
      p = connectedPorts.length;
      connectedPorts.push({
        machine,
        portIndex,
        input: isInput,
        qtyPerCraft: isInput
          ? machines[machine]!.inQty[portIndex]!
          : machines[machine]!.outQty[portIndex]!,
        edges: [],
      });
      portLookup.set(key, p);
    }
    return p;
  };
  for (const edge of input.edges as EdgeIn[]) {
    const src = machineIndex.get(edge.source);
    const dst = machineIndex.get(edge.target);
    if (src === undefined || dst === undefined) continue;
    if (
      !hasPort(machines[src]!, edge.sourceOutput, false) ||
      !hasPort(machines[dst]!, edge.targetInput, true)
    ) {
      continue;
    }
    const srcPort = intern(src, edge.sourceOutput, false);
    const dstPort = intern(dst, edge.targetInput, true);
    const e = edges.length;
    edges.push({ id: edge.id, srcPort, dstPort });
    connectedPorts[srcPort]!.edges.push(e);
    connectedPorts[dstPort]!.edges.push(e);
  }
  const drawnEdges = edges.length;

  // A buffer is wiring (Java `buildBuffers`): an edge from each maker to each user of the same ingredient, after the
  // drawn edges, in drawer, link and taker order; its rule is a row over their flows.
  const usable = (link: { node: Id; port: number }, isInput: boolean): number | undefined => {
    const m = machineIndex.get(link.node);
    if (m === undefined) return undefined;
    const md = machines[m]!;
    if (!hasPort(md, link.port, isInput)) return undefined;
    const qty = isInput ? md.inQty[link.port]! : md.outQty[link.port]!;
    return qty > 0 ? m : undefined;
  };
  const bufferEdges: number[][] = [];
  for (const drawer of input.drawers) {
    const made: number[] = [];
    bufferEdges.push(made);
    if (drawer.kind !== "BUFFER") continue;
    for (const from of drawer.links) {
      const src = usable(from, false);
      if (src === undefined) continue;
      for (const to of drawer.takers ?? []) {
        const dst = usable(to, true);
        if (dst === undefined) continue;
        if (
          machines[src]!.spec.outputs[from.port]!.resource !==
          machines[dst]!.spec.inputs[to.port]!.resource
        )
          continue;
        const srcPort = intern(src, from.port, false);
        const dstPort = intern(dst, to.port, true);
        const e = edges.length;
        edges.push({ id: bufferEdgeId(drawer.id, from, to), srcPort, dstPort });
        connectedPorts[srcPort]!.edges.push(e);
        connectedPorts[dstPort]!.edges.push(e);
        made.push(e);
      }
    }
  }

  const pools: PoolData[] = [];
  for (const pool of input.pools) {
    if (!(pool.capacity > 0)) continue;
    const members: number[] = [];
    for (const id of pool.machines) {
      const m = machineIndex.get(id);
      if (m !== undefined && !members.includes(m)) members.push(m);
    }
    if (members.length === 0) continue;
    pools.push({
      machines: members,
      capacity: pool.capacity,
      exact: pool.exact,
      upTo: !pool.exact && pool.upTo === true,
    });
  }

  const drawers: DrawerRow[] = [];
  input.drawers.forEach((drawer, at) => {
    if (drawer.kind === "BUFFER") {
      const refs: PortRef[] = [];
      for (const link of drawer.links) {
        if (usable(link, false) !== undefined)
          refs.push({ node: link.node, port: link.port, input: false });
      }
      for (const link of drawer.takers ?? []) {
        if (usable(link, true) !== undefined)
          refs.push({ node: link.node, port: link.port, input: true });
      }
      drawers.push({
        id: drawer.id,
        label: drawer.label,
        kind: drawer.kind,
        rule: drawer.rule,
        rate: drawer.rate,
        extentMachines: [],
        extentQty: [],
        externalPorts: [],
        links: refs,
        flowEdges: bufferEdges[at]!,
      });
      return;
    }
    const isInput = drawerLinksInputs(drawer.kind);
    const perMachine = new Map<number, number>();
    const ports: number[] = [];
    const refs: PortRef[] = [];
    for (const link of drawer.links) {
      const m = machineIndex.get(link.node);
      if (m === undefined) continue;
      const md = machines[m]!;
      if (!hasPort(md, link.port, isInput)) continue;
      const qty = isInput ? md.inQty[link.port]! : md.outQty[link.port]!;
      if (!(qty > 0)) continue;
      refs.push({ node: link.node, port: link.port, input: isInput });
      const port = portLookup.get(portKey(m, link.port, isInput));
      if (port !== undefined) {
        if (!ports.includes(port)) ports.push(port);
      } else {
        perMachine.set(m, (perMachine.get(m) ?? 0) + qty);
      }
    }
    const sorted = [...perMachine.entries()].sort((a, b) => a[0] - b[0]);
    const hasRule = drawer.kind === "SOURCE" || drawer.kind === "PRODUCT";
    drawers.push({
      id: drawer.id,
      label: drawer.label,
      kind: drawer.kind,
      rule: hasRule ? drawer.rule : "ANY",
      rate: drawer.rate,
      extentMachines: sorted.map((x) => x[0]),
      extentQty: sorted.map((x) => x[1]),
      externalPorts: ports,
      links: refs,
      flowEdges: [],
    });
  });

  const { portComponent, portGate, gates } = buildGates(connectedPorts, edges);
  const portSteps = portStepsOf(machines.length, connectedPorts, portComponent);
  return {
    machines,
    machineIndex,
    edges,
    drawnEdges,
    connectedPorts,
    portLookup,
    gates,
    pools,
    drawers,
    portGate,
    portComponent,
    portSteps,
  };
}
