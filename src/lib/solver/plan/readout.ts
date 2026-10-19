/**
 * The Up to read-out (docs/up-to.md, "The read-out"; `SolutionView.upTo`): why each Up to card runs where it does at
 * the committed point. Every answer is a probe's optimum compared with the point, under the trading the point was
 * settled under (`ctx.committedTrades`); one counted budget per island (`readoutBudget`, work never time), past
 * which a pool's reason is null.
 *
 * The reasons are old Build's (`node-verdict.ts`, `deriveNodeVerdict`): what a card's inputs allow is weighed against
 * what its outputs allow, and a card at full speed is a bottleneck when someone downstream goes short of what it makes.
 *
 * - Below its capacity, with every other pool held at least at its level (free to rise, never to give way): `capable`
 *   is the most it reaches with a free sink at every output (its inputs as they are), `disposal` the most with every
 *   input fed freely (its outputs as they are). Outputs strictly tighter (`disposal < capable`) is CLOGGED (UNUSED at
 *   zero); otherwise, short at its inputs (`capable` below its capacity, and feeding them raises it) is STARVED, the
 *   input story first as in old Build; else LIMITED. `port` is the first port on that side whose free end alone (the
 *   other side free) raises it, `tied` the others that do; when only several together do, `port` is the first of them
 *   in machine, then port order and `tied` the rest. Others are held from below only: held at their levels from above
 *   too, a pool in a chain would be pinned from both sides (its feeder could not send more, its taker could not take
 *   more) and no port could ever explain it.
 * - At its capacity: BOTTLENECK when the rest of the plan would use more of it, or when it makes what a STARVED pool's
 *   short port takes (the inverse of `upstream`); else FULL. "Would use more": with its cap and every push band gone,
 *   the Up to pools it feeds (wire by wire, downstream) and the unmet drawers it feeds can do better than now, and
 *   `wants` is the least machine time that does it. Only what it feeds counts: a pool upstream that it holds back is
 *   that pool's CLOGGED, not this one's BOTTLENECK. Else, beside a starved pool, `wants` is its capacity and what the
 *   starved pools would draw of it at their own capacity beyond what they draw now, over its per-machine rate (each
 *   maker is given the whole). An Exactly card on one of its output networks that a forced input still feeds wants
 *   more too: that input over its per-machine rate.
 *
 * The pools below their capacity are read first (pool order), then those at it: an at-capacity pool's reason looks at
 * who is starved.
 */
import type { SolveContext } from "./context";
import { loopsOf } from "./gates";
import { compareIds } from "./ids";
import { levelTerms, priceLevel, runModel, type ModelLp, type SolveResult } from "./lp";
import { portKey } from "./model";
import { keptUpTo, levelOf } from "./push";
import { tradeModel, type Trades } from "./trade";
import type { Id, PortRef, UpToLoop, UpToReadout, UpToReason } from "./types";
import { NUMERICS } from "./validate";

/** The read-out's models per island, at the least... */
export const MAX_READOUT_LPS = 96;
/** ...and per Up to pool on it, when that comes to more (a pool below its capacity takes three to five). */
export const READOUT_LPS_PER_POOL = 8;
/** A pool within this of its capacity (in levels) is at it. */
export const AT_CAPACITY = 1e-6;

/** The read-out's budget for a context: counted from its pools, never from time. */
export function readoutBudget(pools: number): number {
  return Math.max(MAX_READOUT_LPS, READOUT_LPS_PER_POOL * pools);
}

/** Counted work: a model runs only while the budget lasts; once one is refused, every later pool reads null. */
class Budget {
  spent = false;

  constructor(private left: number) {}

  run(ctx: SolveContext, lp: ModelLp, label: string): SolveResult | "spent" {
    if (this.spent || this.left <= 0) {
      this.spent = true;
      return "spent";
    }
    this.left--;
    return runModel(ctx, lp, label);
  }
}

type Why = { reason: UpToReason; port?: PortRef; tied?: PortRef[]; wants?: number };

/**
 * The read-out of every Up to pool, by `node`, and the rings they blame each other round (`findLoops`); undefined when
 * the context has none.
 */
export function readUpTo(
  ctx: SolveContext,
): { readouts: UpToReadout[]; loops: UpToLoop[] } | undefined {
  const pools = ctx.upToPools;
  if (pools.length === 0) return undefined;
  const point = ctx.point!;
  const trades = ctx.committedTrades;
  const budget = new Budget(readoutBudget(pools.length));
  const read = new Map<number, UpToReadout>();
  for (const p of pools) {
    const data = ctx.model.pools[p]!;
    const machines = data.machines.map((m) => ctx.model.machines[m]!.spec.id);
    read.set(p, {
      node: machines[0]!,
      machines,
      capacity: data.capacity,
      reached: ctx.poolTime(p, point.extents),
      reason: null,
    });
  }
  const level = (p: number) => levelOf(ctx, p, point.extents);
  const full = pools.filter((p) => level(p) >= 1 - AT_CAPACITY);
  for (const p of pools) {
    if (full.includes(p) || trades === null || budget.spent) continue;
    const why = holdBackOf(ctx, p, level(p), trades, budget);
    if (why !== null) Object.assign(read.get(p)!, why);
  }
  const starved = starvedPorts(ctx, read);
  for (const p of full) {
    if (trades === null || budget.spent) continue;
    const why = wantsOf(ctx, p, trades, budget, starved);
    if (why !== null) Object.assign(read.get(p)!, why);
  }
  for (const p of pools) {
    const readout = read.get(p)!;
    if (readout.reason !== "STARVED" || readout.port === undefined) continue;
    const upstream = upstreamOf(ctx, p, readout.port, read);
    if (upstream.length > 0) readout.upstream = upstream;
  }
  return {
    readouts: [...read.values()].sort((a, b) => compareIds(a.node, b.node)),
    loops: findLoops(ctx, read),
  };
}

// ---------------------------------------------------------------------------
// Loops: dead loops and clog locks
// ---------------------------------------------------------------------------

/**
 * The rings of Up to pools that blame each other (old Build's dead loop and clog lock: `death-spiral.ts`,
 * `clog-lock.ts`). A pool blames the Up to pools on the wire network of its `port` and `tied` ports: for a STARVED
 * pool those that make what it is short of, for a CLOGGED or UNUSED one those that take what it cannot get rid of.
 * A ring is a strongly connected part of that relation (a pool blaming itself counts) whose members all stand still and
 * all read STARVED (DEAD_LOOP) or all UNUSED (CLOG_LOCK). Standing still is what makes it a ring's own doing: a ring that
 * loses material every lap winds down to zero with nothing feeding it, so one that runs at all is fed from outside and
 * held back by that feed, which its members' reasons already point at. Members in pool order, rings by their first
 * member's `node`. A pure graph over the read-out and the model's networks: no model runs.
 */
export function findLoops(ctx: SolveContext, read: ReadonlyMap<number, UpToReadout>): UpToLoop[] {
  const model = ctx.model;
  const loops: UpToLoop[] = [];
  for (const kind of ["DEAD_LOOP", "CLOG_LOCK"] as const) {
    const starving = kind === "DEAD_LOOP";
    // UNUSED is CLOGGED standing still.
    const isMember = (p: number) => {
      const reason = read.get(p)!.reason;
      return starving ? reason === "STARVED" && idle(ctx, p) : reason === "UNUSED";
    };
    const members = ctx.upToPools.filter(isMember);
    if (members.length === 0) continue;
    // What each member blames (its short inputs, or its full outputs), and the networks it makes on or takes from.
    const blames = members.map((p) => {
      const r = read.get(p)!;
      const out: Array<{ ref: PortRef; network: number }> = [];
      for (const ref of [r.port!, ...(r.tied ?? [])]) {
        const m = model.machineIndex.get(ref.node);
        const q =
          m === undefined ? undefined : model.portLookup.get(portKey(m, ref.port, ref.input));
        if (q !== undefined) out.push({ ref, network: model.portComponent[q]! });
      }
      return out;
    });
    const touches = members.map((p) => {
      const own = new Set(model.pools[p]!.machines);
      const networks = new Set<number>();
      // A starved pool is fed by those that make there; a clogged one is held by those that take there.
      model.connectedPorts.forEach((cp, q) => {
        if (own.has(cp.machine) && cp.input !== starving) networks.add(model.portComponent[q]!);
      });
      return networks;
    });
    const next = members.map((_, k) => {
      const to: number[] = [];
      for (const { network } of blames[k]!) {
        touches.forEach((networks, j) => {
          if (networks.has(network) && !to.includes(j)) to.push(j);
        });
      }
      return to.sort((a, b) => a - b);
    });
    const ring = loopsOf(next);
    const byRing = new Map<number, number[]>();
    members.forEach((_, k) => {
      const list = byRing.get(ring[k]!) ?? [];
      byRing.set(ring[k]!, list);
      list.push(k);
    });
    for (const group of byRing.values()) {
      if (group.length === 1 && !next[group[0]!]!.includes(group[0]!)) continue;
      const ports: PortRef[] = [];
      for (const k of group) {
        for (const { ref, network } of blames[k]!) {
          if (group.some((j) => touches[j]!.has(network))) ports.push(ref);
        }
      }
      loops.push({ kind, nodes: group.map((k) => read.get(members[k]!)!.node), ports });
    }
  }
  return loops.sort((a, b) => compareIds(a.nodes[0]!, b.nodes[0]!));
}

/** Whether every machine of a pool stands still at the committed point (within the solve's dust). */
function idle(ctx: SolveContext, pool: number): boolean {
  const point = ctx.point!;
  const dust = NUMERICS.dust * ctx.solutionScaleOf(point);
  return ctx.model.pools[pool]!.machines.every((m) => point.extents[m]! <= dust);
}

/** A STARVED pool's short port (its `port` or a `tied` one), as a connected port: unwired ones have no network. */
interface Starved {
  pool: number;
  port: number;
}

function starvedPorts(ctx: SolveContext, read: ReadonlyMap<number, UpToReadout>): Starved[] {
  const out: Starved[] = [];
  for (const [p, readout] of read) {
    if (readout.reason !== "STARVED" || readout.port === undefined) continue;
    for (const ref of [readout.port, ...(readout.tied ?? [])]) {
      const m = ctx.model.machineIndex.get(ref.node);
      const port =
        m === undefined ? undefined : ctx.model.portLookup.get(portKey(m, ref.port, true));
      if (port !== undefined) out.push({ pool: p, port });
    }
  }
  return out;
}

/** A pool's first output on a wire network (machine, then port order), as its per-machine rate; 0 when it makes none there. */
function rateInto(ctx: SolveContext, pool: number, network: number): number {
  const model = ctx.model;
  for (const m of model.pools[pool]!.machines) {
    const md = model.machines[m]!;
    for (let i = 0; i < md.outQty.length; i++) {
      const o = model.portLookup.get(portKey(m, i, false));
      if (o === undefined || model.portComponent[o] !== network) continue;
      const rate = model.connectedPorts[o]!.qtyPerCraft / ctx.countOf(m, 1);
      if (rate > 0) return rate;
    }
  }
  return 0;
}

/**
 * Beside starved pools: null when the pool makes nothing a STARVED pool's short port takes, else the machines it would
 * take to give each such port what its pool would draw at its own capacity (beyond what it draws now).
 */
function starvedDemand(
  ctx: SolveContext,
  pool: number,
  starved: readonly Starved[],
): number | null {
  const model = ctx.model;
  const point = ctx.point!;
  let demand: number | null = null;
  for (const { pool: s, port } of starved) {
    if (s === pool) continue;
    const rate = rateInto(ctx, pool, model.portComponent[port]!);
    if (!(rate > 0)) continue;
    const taker = model.connectedPorts[port]!;
    const now = point.extents[taker.machine]! * taker.qtyPerCraft;
    const data = model.pools[s]!;
    const flat = (taker.qtyPerCraft * data.capacity) / ctx.countOf(taker.machine, 1);
    const level = levelOf(ctx, s, point.extents);
    // A shared machine's recipe at capacity: its draw now, scaled up to the pool's whole time.
    const atCapacity = data.machines.length === 1 || !(level > AT_CAPACITY) ? flat : now / level;
    demand = (demand ?? 0) + Math.max(0, atCapacity - now) / rate;
  }
  return demand;
}

// ---------------------------------------------------------------------------
// At its capacity: FULL or BOTTLENECK
// ---------------------------------------------------------------------------

/** The machines a pool's outputs reach, wire by wire (its own only round a loop). */
function downstreamOf(ctx: SolveContext, pool: number): Set<number> {
  const model = ctx.model;
  const outputs: number[][] = model.machines.map(() => []);
  model.connectedPorts.forEach((port, p) => {
    if (!port.input) outputs[port.machine]!.push(p);
  });
  const reached = new Set<number>();
  const queue = [...model.pools[pool]!.machines];
  while (queue.length > 0) {
    const m = queue.pop()!;
    for (const p of outputs[m]!) {
      for (const e of model.connectedPorts[p]!.edges) {
        const taker = model.connectedPorts[model.edges[e]!.dstPort]!.machine;
        if (!reached.has(taker)) {
          reached.add(taker);
          queue.push(taker);
        }
      }
    }
  }
  return reached;
}

/** An unmet drawer asking for flow, and the rate it asked for. */
interface Unmet {
  drawer: number;
  target: number;
}

/** The unmet drawers with a lower bound linked to the pool or to what it feeds, in shortfall order. */
function unmetFed(ctx: SolveContext, pool: number, below: ReadonlySet<number>): Unmet[] {
  const model = ctx.model;
  const own = new Set(model.pools[pool]!.machines);
  const out: Unmet[] = [];
  for (const shortfall of ctx.shortfalls) {
    if (shortfall.rule !== "AT_LEAST" && shortfall.rule !== "EXACTLY") continue;
    if (!(shortfall.target > 0)) continue;
    const d = model.drawers.findIndex((row) => row.id === shortfall.drawer);
    if (d < 0 || out.some((u) => u.drawer === d)) continue;
    const fed = model.drawers[d]!.links.some((link) => {
      const m = model.machineIndex.get(link.node);
      return m !== undefined && (own.has(m) || below.has(m));
    });
    if (fed) out.push({ drawer: d, target: shortfall.target });
  }
  return out;
}

/** A drawer's total as row terms, over `scale`. */
function drawerTerms(
  ctx: SolveContext,
  lp: ModelLp,
  d: number,
  scale: number,
): { cols: number[]; vals: number[] } {
  const row = ctx.model.drawers[d]!;
  const cols: number[] = [];
  const vals: number[] = [];
  row.extentMachines.forEach((m, i) => {
    cols.push(lp.extentCol(m));
    vals.push(row.extentQty[i]! / scale);
  });
  for (const e of row.flowEdges) {
    cols.push(lp.flowCol(e));
    vals.push(1 / scale);
  }
  for (const p of row.externalPorts) {
    cols.push(lp.extCol(p));
    vals.push(1 / scale);
  }
  return { cols, vals };
}

/**
 * The model of "would the plan use more": the trading held, the pool's cap and every push band gone; the objective
 * (to maximise) is the fed pools' levels and the fed drawers' met fractions, returned as row terms.
 */
function usingModel(
  ctx: SolveContext,
  pool: number,
  trades: Trades,
  fedPools: readonly number[],
  fedDrawers: readonly Unmet[],
): { lp: ModelLp; cols: number[]; vals: number[] } {
  ctx.droppedPools.add(pool);
  let lp: ModelLp;
  try {
    lp = tradeModel(ctx, { ...trades, floors: [] });
  } finally {
    ctx.droppedPools.delete(pool);
  }
  const cols: number[] = [];
  const vals: number[] = [];
  for (const q of fedPools) {
    const terms = levelTerms(ctx, lp, q);
    cols.push(...terms.cols);
    vals.push(...terms.vals);
  }
  for (const { drawer, target } of fedDrawers) {
    // Its met fraction: f in 0..1 with total / target - f >= 0.
    const f = lp.addColumn(0, 1, 0);
    const terms = drawerTerms(ctx, lp, drawer, target);
    lp.addRow([...terms.cols, f], [...terms.vals, -1], 0, Infinity);
    cols.push(f);
    vals.push(1);
  }
  return { lp, cols, vals };
}

/** The value of row terms at a model's solution. */
function valueOf(cols: readonly number[], vals: readonly number[], x: readonly number[]): number {
  let total = 0;
  cols.forEach((c, i) => {
    total += vals[i]! * x[c]!;
  });
  return total;
}

/** Whether a machine's count is pinned exactly: a hard pin of its own, or an exact pool. */
function isExact(ctx: SolveContext, m: number): boolean {
  if (!Number.isNaN(ctx.pinnedExtent[m]!)) return true;
  return ctx.model.pools.some(
    (pool, p) => pool.exact && !ctx.droppedPools.has(p) && pool.machines.includes(m),
  );
}

/**
 * Machines an Exactly card on one of the pool's output networks still needs: each forced input there (a wired port with
 * no drawer bringing material in) over the pool's per-machine rate of that output.
 */
function forcedDemand(ctx: SolveContext, pool: number): number {
  const model = ctx.model;
  const point = ctx.point!;
  const dust = NUMERICS.dust * ctx.solutionScaleOf(point);
  const drawn = ctx.drawnPorts;
  const counted = new Set<number>();
  let demand = 0;
  for (const m of model.pools[pool]!.machines) {
    model.connectedPorts.forEach((out, o) => {
      if (out.machine !== m || out.input) return;
      const perMachine = out.qtyPerCraft / ctx.countOf(m, 1);
      if (!(perMachine > 0)) return;
      const network = model.portComponent[o]!;
      model.connectedPorts.forEach((port, q) => {
        if (!port.input || model.portComponent[q] !== network || counted.has(q) || drawn.has(q))
          return;
        if (!isExact(ctx, port.machine) || !(point.externals[q]! > dust)) return;
        counted.add(q);
        demand += point.externals[q]! / perMachine;
      });
    });
  }
  return demand;
}

function wantsOf(
  ctx: SolveContext,
  pool: number,
  trades: Trades,
  budget: Budget,
  starved: readonly Starved[],
): Why | null {
  const point = ctx.point!;
  const capacity = ctx.model.pools[pool]!.capacity;
  const below = downstreamOf(ctx, pool);
  const fedPools = keptUpTo(ctx).filter(
    (q) => q !== pool && ctx.model.pools[q]!.machines.some((m) => below.has(m)),
  );
  const fedDrawers = unmetFed(ctx, pool, below);
  let wants: number | null = null;
  if (fedPools.length > 0 || fedDrawers.length > 0) {
    let now = 0;
    for (const q of fedPools) now += levelOf(ctx, q, point.extents);
    for (const { drawer, target } of fedDrawers) {
      now += Math.min(
        1,
        ctx.drawerTotal(drawer, point.extents, point.flows, point.externals) / target,
      );
    }
    const most = usingModel(ctx, pool, trades, fedPools, fedDrawers);
    most.cols.forEach((c, i) => {
      most.lp.cost[c] = most.lp.cost[c]! - most.vals[i]!;
    });
    const used = budget.run(ctx, most.lp, "up to: would the plan use more");
    if (used === "spent") return null;
    const best = used.ok ? valueOf(most.cols, most.vals, used.x) : now;
    if (best > now + NUMERICS.readoutTol * Math.max(1, most.cols.length)) {
      // The least of it that does: hold the optimum (the first model's own point keeps it, so no room), then the
      // pool's own machine time as low as it goes.
      const least = usingModel(ctx, pool, trades, fedPools, fedDrawers);
      least.lp.addRow(least.cols, least.vals, best, Infinity);
      priceLevel(ctx, least.lp, pool, 1);
      const takes = budget.run(ctx, least.lp, "up to: how many it would take");
      if (takes === "spent") return null;
      if (takes.ok) {
        const time = ctx.poolTime(pool, takes.point.extents);
        if (time > capacity * (1 + NUMERICS.readoutTol)) wants = time;
      }
    }
  }
  if (wants === null) {
    // Someone short of what it makes: a STARVED pool's short port on one of its output networks.
    const short = starvedDemand(ctx, pool, starved);
    if (short !== null) wants = capacity + short;
  }
  const forced = forcedDemand(ctx, pool);
  if (forced > 0) wants = (wants ?? capacity) + forced;
  return wants === null ? { reason: "FULL" } : { reason: "BOTTLENECK", wants };
}

// ---------------------------------------------------------------------------
// Below its capacity: STARVED, CLOGGED, UNUSED or LIMITED
// ---------------------------------------------------------------------------

/** A port a probe can give a free end: a wired one by a free column, an unwired one by lifting its drawers' caps. */
interface Feed {
  ref: PortRef;
  /** The connected port, or null when unwired. */
  port: number | null;
  /** Unwired: the capped drawers linked to it. */
  drawers: number[];
}

/**
 * The pool's ports on one side a free end could matter at, in machine then port order: every wired one, and every
 * unwired one a capped source (inputs) or product (outputs) drawer is linked to. Other unwired ports already are free.
 */
function feedsOf(ctx: SolveContext, pool: number, input: boolean): Feed[] {
  const model = ctx.model;
  const feeds: Feed[] = [];
  for (const m of model.pools[pool]!.machines) {
    const md = model.machines[m]!;
    (input ? md.inQty : md.outQty).forEach((qty, i) => {
      if (!(qty > 0)) return;
      const ref: PortRef = { node: md.spec.id, port: i, input };
      const port = model.portLookup.get(portKey(m, i, input));
      if (port !== undefined) {
        feeds.push({ ref, port, drawers: [] });
        return;
      }
      const drawers: number[] = [];
      model.drawers.forEach((row, d) => {
        if (row.kind !== (input ? "SOURCE" : "PRODUCT") || Number.isNaN(ctx.drawerUpper[d]!))
          return;
        if (row.links.some((l) => l.node === ref.node && l.port === ref.port && l.input === input))
          drawers.push(d);
      });
      if (drawers.length > 0) feeds.push({ ref, port: null, drawers });
    });
  }
  return feeds;
}

/** The most the pool's level reaches with free ends at `feeds`, others held from below; `fallback` when nothing is found. */
function highest(
  ctx: SolveContext,
  pool: number,
  held: Trades,
  feeds: readonly Feed[],
  label: string,
  budget: Budget,
  fallback: number,
): number | "spent" {
  const saved = new Map<number, number>();
  for (const f of feeds)
    for (const d of f.drawers) if (!saved.has(d)) saved.set(d, ctx.drawerUpper[d]!);
  for (const d of saved.keys()) ctx.drawerUpper[d] = Number.NaN;
  let lp: ModelLp;
  try {
    lp = tradeModel(ctx, held);
  } finally {
    for (const [d, upper] of saved) ctx.drawerUpper[d] = upper;
  }
  for (const f of feeds) if (f.port !== null) lp.feedPort(f.port);
  priceLevel(ctx, lp, pool, -1);
  const result = budget.run(ctx, lp, label);
  if (result === "spent") return "spent";
  return result.ok ? levelOf(ctx, pool, result.point.extents) : fallback;
}

/**
 * On one side, the first of `feeds` whose free end alone (with every one of `others` free too) lifts the pool past
 * `past`, and the others that do; when none does alone, the first of them and the rest (they are short together).
 */
function shortPort(
  ctx: SolveContext,
  pool: number,
  held: Trades,
  feeds: readonly Feed[],
  others: readonly Feed[],
  past: number,
  label: string,
  budget: Budget,
): { port: PortRef; tied?: PortRef[] } | "spent" {
  if (feeds.length === 1) return { port: feeds[0]!.ref };
  let port: PortRef | null = null;
  const tied: PortRef[] = [];
  for (const f of feeds) {
    const reach = highest(ctx, pool, held, [...others, f], label, budget, past);
    if (reach === "spent") return "spent";
    if (!(reach > past + NUMERICS.readoutTol)) continue;
    if (port === null) port = f.ref;
    else tied.push(f.ref);
  }
  if (port === null) return { port: feeds[0]!.ref, tied: feeds.slice(1).map((f) => f.ref) };
  return tied.length > 0 ? { port, tied } : { port };
}

function holdBackOf(
  ctx: SolveContext,
  pool: number,
  level: number,
  trades: Trades,
  budget: Budget,
): Why | null {
  // Every other pool at least at its level, free to rise; this one free under its cap.
  const held: Trades = {
    ...trades,
    floors: trades.floors.filter((b) => b.pool !== pool).map((b) => ({ ...b, hi: 1 })),
  };
  const ins = feedsOf(ctx, pool, true);
  const outs = feedsOf(ctx, pool, false);
  const tol = NUMERICS.readoutTol;
  // What its inputs allow (every output free) and what its outputs allow (every input fed).
  const capable =
    outs.length > 0 ? highest(ctx, pool, held, outs, "up to: outputs free", budget, level) : level;
  if (capable === "spent") return null;
  const disposal =
    ins.length > 0 ? highest(ctx, pool, held, ins, "up to: inputs fed", budget, level) : level;
  if (disposal === "spent") return null;
  // The outputs strictly tighter: CLOGGED. A tie tells the input story first, as old Build does.
  if (disposal < capable - tol) {
    const at = shortPort(ctx, pool, held, outs, ins, disposal, "up to: one output free", budget);
    if (at === "spent") return null;
    return { reason: idle(ctx, pool) ? "UNUSED" : "CLOGGED", ...at };
  }
  if (capable < 1 - tol && ins.length > 0) {
    // Short at its inputs only when feeding them (its outputs free) does raise it.
    const both =
      outs.length > 0
        ? highest(ctx, pool, held, [...ins, ...outs], "up to: all free", budget, capable)
        : disposal;
    if (both === "spent") return null;
    if (both > capable + tol) {
      const at = shortPort(ctx, pool, held, ins, outs, capable, "up to: one input fed", budget);
      if (at === "spent") return null;
      return { reason: "STARVED", ...at };
    }
  }
  return { reason: "LIMITED" };
}

/** STARVED's `upstream`: the FULL or BOTTLENECK Up to pools making what the short input takes, by `node`. */
function upstreamOf(
  ctx: SolveContext,
  pool: number,
  short: PortRef,
  read: ReadonlyMap<number, UpToReadout>,
): Id[] {
  const model = ctx.model;
  const m = model.machineIndex.get(short.node);
  const port = m === undefined ? undefined : model.portLookup.get(portKey(m, short.port, true));
  if (port === undefined) return [];
  const network = model.portComponent[port]!;
  const out: Id[] = [];
  for (const q of ctx.upToPools) {
    if (q === pool) continue;
    const readout = read.get(q)!;
    if (readout.reason !== "FULL" && readout.reason !== "BOTTLENECK") continue;
    const members = new Set(model.pools[q]!.machines);
    const makes = model.connectedPorts.some(
      (cp, p) => !cp.input && members.has(cp.machine) && model.portComponent[p] === network,
    );
    if (makes) out.push(readout.node);
  }
  return out.sort(compareIds);
}
