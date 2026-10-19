/**
 * Gates and portSteps (spec-solver 3.1.3, 3.1.4, 3.1.6). Pure functions over the connected-port tables that
 * `model.ts` builds; the gate and component numbering is part of the answer (tie weights and swap order key on it).
 */

/** The slice of a connected port these functions read. */
export interface PortShape {
  machine: number;
  input: boolean;
}

export interface Gate {
  input: boolean;
  /** Connected-port indices, ascending. */
  ports: number[];
}

function find(root: number[], i: number): number {
  let r = i;
  while (root[r] !== r) r = root[r]!;
  // full compression so the walk stays short on long chains
  let c = i;
  while (root[c] !== r) {
    const next = root[c]!;
    root[c] = r;
    c = next;
  }
  return r;
}

/**
 * Components and gates. One component per wire network (union-find over the edges' two ports); one gate per
 * (component, side), numbered by the lowest port in it.
 */
export function buildGates(
  ports: readonly PortShape[],
  edges: ReadonlyArray<{ srcPort: number; dstPort: number }>,
): { portComponent: number[]; portGate: number[]; gates: Gate[] } {
  const n = ports.length;
  const root = Array.from({ length: n }, (_, i) => i);
  for (const e of edges) {
    const a = find(root, e.srcPort);
    const b = find(root, e.dstPort);
    if (a !== b) root[a] = b;
  }
  const portComponent = new Array<number>(n).fill(0);
  const portGate = new Array<number>(n).fill(0);
  const gates: Gate[] = [];
  const lookup = new Map<number, number>();
  for (let p = 0; p < n; p++) {
    const input = ports[p]!.input;
    portComponent[p] = find(root, p);
    const key = portComponent[p]! * 2 + (input ? 1 : 0);
    let gate = lookup.get(key);
    if (gate === undefined) {
      gate = gates.length;
      gates.push({ input, ports: [] });
      lookup.set(key, gate);
    }
    gates[gate]!.ports.push(p);
    portGate[p] = gate;
  }
  return { portComponent, portGate, gates };
}

/**
 * Tarjan's strongly connected components, iterative. Loops are numbered in the order they complete, so every arc
 * between two loops runs from a higher number to a lower one.
 */
export function loopsOf(next: readonly (readonly number[])[]): number[] {
  const n = next.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const loop = new Array<number>(n).fill(0);
  const cursor = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const path: number[] = [];
  let counter = 0;
  let loops = 0;
  for (let start = 0; start < n; start++) {
    if (index[start]! >= 0) continue;
    path.push(start);
    index[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = true;
    while (path.length > 0) {
      const v = path[path.length - 1]!;
      const succ = next[v]!;
      if (cursor[v]! < succ.length) {
        const w = succ[cursor[v]!++]!;
        if (index[w]! < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          path.push(w);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      path.pop();
      if (path.length > 0) {
        const parent = path[path.length - 1]!;
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          loop[w] = loops;
        } while (w !== v);
        loops++;
      }
    }
  }
  return loop;
}

/**
 * Per connected port, how far along the plan a trade there is, in machine steps. At an input: the fewest machines it
 * takes to make the good, counting the one that makes it (wheat 1, flour 2). At an output: the most machines the good
 * could still go through, counting the one that takes it (wheat 2, flour 1). A loop (SCC of machines and networks) is
 * one step.
 */
export function portStepsOf(
  machineCount: number,
  ports: readonly PortShape[],
  portComponent: readonly number[],
): number[] {
  const n = machineCount;
  const networkNode = new Map<number, number>();
  for (let p = 0; p < ports.length; p++) {
    if (!networkNode.has(portComponent[p]!)) networkNode.set(portComponent[p]!, n + networkNode.size);
  }
  const nodes = n + networkNode.size;
  const next: number[][] = Array.from({ length: nodes }, () => []);
  const makers: number[][] = Array.from({ length: nodes }, () => []);
  const takers: number[][] = Array.from({ length: nodes }, () => []);
  for (let p = 0; p < ports.length; p++) {
    const port = ports[p]!;
    const net = networkNode.get(portComponent[p]!)!;
    const side = port.input ? takers[net]! : makers[net]!;
    if (side.includes(port.machine)) continue;
    side.push(port.machine);
    if (port.input) next[net]!.push(port.machine);
    else next[port.machine]!.push(net);
  }
  const loop = loopsOf(next);
  let loops = 0;
  for (const l of loop) loops = Math.max(loops, l + 1);
  const hasMachine = new Array<boolean>(loops).fill(false);
  for (let m = 0; m < n; m++) hasMachine[loop[m]!] = true;
  const after: number[][] = Array.from({ length: loops }, () => []);
  for (let v = 0; v < nodes; v++) {
    for (const w of next[v]!) if (loop[v] !== loop[w]) after[loop[v]!]!.push(loop[w]!);
  }
  const stage = new Array<number>(loops).fill(0);
  const depth = new Array<number>(loops).fill(0);
  for (let l = loops - 1; l >= 0; l--) {
    for (const k of after[l]!) stage[k] = Math.max(stage[k]!, stage[l]! + (hasMachine[k] ? 1 : 0));
  }
  for (let l = 0; l < loops; l++) {
    for (const k of after[l]!) depth[l] = Math.max(depth[l]!, depth[k]! + (hasMachine[k] ? 1 : 0));
  }
  const out = new Array<number>(ports.length).fill(1);
  for (let p = 0; p < ports.length; p++) {
    const port = ports[p]!;
    const net = networkNode.get(portComponent[p]!)!;
    if (port.input) {
      let fewest = Number.MAX_SAFE_INTEGER;
      for (const m of makers[net]!) fewest = Math.min(fewest, stage[loop[m]!]!);
      out[p] = (fewest === Number.MAX_SAFE_INTEGER ? 0 : fewest) + 1;
    } else {
      let most = 0;
      for (const m of takers[net]!) most = Math.max(most, depth[loop[m]!]!);
      out[p] = most + 1;
    }
  }
  return out;
}
