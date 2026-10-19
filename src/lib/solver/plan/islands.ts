/**
 * A plan's islands (spec-solver 5; Java `Islands`): the parts nothing joins, each a plan of its own. Machines are joined
 * by a wire, by a shared machine's pool and by a drawer, so no row of any model spans two islands and each solves as
 * it would alone. Each island keeps the plan's order of machines, wires, pools and drawers (island-LOCAL indexing is
 * what makes tiled copies answer as each alone), the pins on its machines, and the choice anchors and stored splits
 * that name them.
 */
import type { Id, PortRef, SolveInput } from "./types";

/** The node of a bearer key (`node:i:port` or `node:o:port`): the text before the first colon. */
export function nodeOfBearer(bearer: string): string {
  const colon = bearer.indexOf(":");
  return colon < 0 ? bearer : bearer.slice(0, colon);
}

/** The plan's islands in the order of their first machine; the plan itself (not a copy) when it is one. */
export function splitIslands(input: SolveInput): SolveInput[] {
  const machines = input.machines;
  const n = machines.length;
  if (n <= 1) return [input];
  const index = new Map<Id, number>();
  machines.forEach((m, i) => {
    if (!index.has(m.id)) index.set(m.id, i); // a repeated id keeps the first
  });
  const root = machines.map((_, i) => i);
  const find = (start: number): number => {
    let m = start;
    while (root[m] !== m) {
      root[m] = root[root[m]!]!;
      m = root[m]!;
    }
    return m;
  };
  const join = (a: number | undefined, b: number | undefined): void => {
    if (a === undefined || b === undefined) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) root[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const e of input.edges) join(index.get(e.source), index.get(e.target));
  for (const pool of input.pools) {
    let first: number | undefined;
    for (const id of pool.machines) {
      const m = index.get(id);
      if (m === undefined) continue;
      if (first === undefined) first = m;
      else join(first, m);
    }
  }
  for (const drawer of input.drawers) {
    let first: number | undefined;
    for (const link of [...drawer.links, ...(drawer.takers ?? [])]) {
      const m = index.get(link.node);
      if (m === undefined) continue;
      if (first === undefined) first = m;
      else join(first, m);
    }
  }

  // islands numbered by their first machine
  const numberOf = new Map<number, number>();
  const island = machines.map((_, m) => {
    const r = find(m);
    let k = numberOf.get(r);
    if (k === undefined) {
      k = numberOf.size;
      numberOf.set(r, k);
    }
    return k;
  });
  const count = numberOf.size;
  if (count === 1) return [input];

  const islandOfIds = (ids: readonly Id[]): number => {
    for (const id of ids) {
      const m = index.get(id);
      if (m !== undefined) return island[m]!;
    }
    return -1;
  };
  const ms: SolveInput["machines"][] = Array.from({ length: count }, () => []);
  const es: SolveInput["edges"][] = Array.from({ length: count }, () => []);
  const ps: SolveInput["pools"][] = Array.from({ length: count }, () => []);
  const ds: SolveInput["drawers"][] = Array.from({ length: count }, () => []);
  const pins: Array<Record<Id, number>> = Array.from({ length: count }, () => ({}));
  const ids: Array<Set<Id>> = Array.from({ length: count }, () => new Set());
  machines.forEach((machine, m) => {
    ms[island[m]!]!.push(machine);
    ids[island[m]!]!.add(machine.id);
    if (Object.prototype.hasOwnProperty.call(input.extentPins, machine.id)) {
      pins[island[m]!]![machine.id] = input.extentPins[machine.id]!;
    }
  });
  for (const e of input.edges) {
    // an edge from a machine the plan lacks is dropped (the model would drop it anyway)
    const s = index.get(e.source);
    if (s !== undefined) es[island[s]!]!.push(e);
  }
  for (const pool of input.pools) {
    const at = islandOfIds(pool.machines);
    ps[at < 0 ? 0 : at]!.push(pool);
  }
  for (const drawer of input.drawers) {
    const at = islandOfIds([...drawer.links, ...(drawer.takers ?? [])].map((l) => l.node));
    ds[at < 0 ? 0 : at]!.push(drawer);
  }

  const choiceIn = (nodes: Set<Id>): PortRef[] | null => {
    if (!input.choice) return null;
    const anchors = input.choice.filter((a) => nodes.has(a.node));
    return anchors.length === 0 ? null : anchors;
  };
  const sparesIn = (nodes: Set<Id>): SolveInput["spares"] => {
    const stored = input.spares;
    const keys = Object.keys(stored);
    if (keys.length === 0) return stored;
    const out: SolveInput["spares"] = {};
    for (const key of keys) {
      if (Object.keys(stored[key]!).some((bearer) => nodes.has(nodeOfBearer(bearer)))) out[key] = stored[key]!;
    }
    return out;
  };

  return Array.from({ length: count }, (_, i) => ({
    mode: input.mode,
    choice: choiceIn(ids[i]!),
    machines: ms[i]!,
    edges: es[i]!,
    pools: ps[i]!,
    drawers: ds[i]!,
    extentPins: pins[i]!,
    spares: sparesIn(ids[i]!),
  }));
}
