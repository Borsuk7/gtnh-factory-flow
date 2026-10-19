/**
 * The Up to rule in the engine (docs/up-to.md): the guard, the push, the drawer relaxation naming the card, and the
 * read-out (`SolutionView.upTo`). Hand-built plans; every machine runs a craft a second per machine unless it says
 * otherwise. Determinism is checked by solving every plan again with the columns in reverse order.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initLpEngine } from "../lp-engine";
import { differences } from "./__fixtures__/compare";
import { loadInput } from "./__fixtures__/load";
import { SolveContext } from "./context";
import { evaluateSupportWith, resolveChoice } from "./enumerate";
import { setColumnOrder, takeLpCount } from "./lp";
import { MAX_READOUT_LPS, readoutBudget } from "./readout";
import { runChain, solvePiece } from "./solve-core";
import { planExtensions, solvePlan } from "./solve-plan";
import { levels } from "./trade";
import {
  benzene,
  budgetPlan,
  buffered,
  banked,
  cappedDrawers,
  chain,
  chain3,
  clogRing,
  deadRing,
  CORPUS_UP_TO,
  everyCountUpTo,
  exactConsumer,
  exactProducer,
  fedRing,
  FIXTURES,
  nothingTakes,
  onlyUpTo,
  pinDiagnosis,
  sharedPool,
  sharedProducer,
  starvedChain,
  toppedLoop,
  toppedLoopTrading,
  twoFullOutputs,
  twoIslands,
  twoProducers,
  twoRings,
  twoShortInputs,
  twoSided,
  unreachableDrawer,
  unwired,
  withAlternatives,
} from "./__fixtures__/up-to/plans";
import type { Answer, Note, PortRef, SolutionView, SolveInput, UpToReadout } from "./types";

beforeAll(async () => {
  await initLpEngine();
});

function solved(i: SolveInput): Extract<Answer, { kind: "solved" }> {
  const answer = solvePlan(i);
  if (answer.kind !== "solved") throw new Error(`failed: ${JSON.stringify(answer.failure)}`);
  return answer;
}

function readoutOf(s: SolutionView, node: string): UpToReadout {
  const found = s.upTo?.find((r) => r.node === node);
  if (!found) throw new Error(`no read-out for ${node}: ${JSON.stringify(s.upTo)}`);
  return found;
}

const ref = (node: string, portIndex: number, input: boolean): PortRef => ({
  node,
  port: portIndex,
  input,
});

function findNote(n: Note, message: string): Note | null {
  if (n.message === message) return n;
  for (const a of n.args) {
    for (const x of Array.isArray(a) ? a : [a]) {
      if (typeof x === "object" && x !== null) {
        const hit = findNote(x as Note, message);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The push and the reasons
// ---------------------------------------------------------------------------

describe("Up to: the push and the read-out", () => {
  it("a chain whose second step is slower: the first CLOGGED at its pace, the second FULL", () => {
    const s = solved(chain(2, 1)).solution;
    expect(s.machineCounts["a"]).toBeCloseTo(1, 9);
    expect(s.machineCounts["b"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "a")).toEqual({
      node: "a",
      machines: ["a"],
      capacity: 2,
      reached: expect.closeTo(1, 9),
      reason: "CLOGGED",
      port: ref("a", 0, false),
    });
    expect(readoutOf(s, "b")).toMatchObject({ reason: "FULL", reached: expect.closeTo(1, 9) });
    expect(s.gatedSources).toEqual([]);
    expect(s.gatedSinks).toEqual([]);
  });

  it("the mirrored chain: the second STARVED with the first upstream, the first a BOTTLENECK wanting 3", () => {
    const s = solved(chain(2, 3)).solution;
    expect(readoutOf(s, "a")).toMatchObject({
      reason: "BOTTLENECK",
      reached: expect.closeTo(2, 9),
      wants: expect.closeTo(3, 9),
    });
    expect(readoutOf(s, "b")).toEqual({
      node: "b",
      machines: ["b"],
      capacity: 3,
      reached: expect.closeTo(2, 9),
      reason: "STARVED",
      port: ref("b", 0, true),
      upstream: ["a"],
    });
  });

  it("benzene: the ovens are the bottleneck and want 3; the tower is starved by them at two thirds", () => {
    const s = solved(benzene()).solution;
    expect(s.machineCounts["oven"]).toBeCloseTo(2, 9);
    expect(s.machineCounts["tower"]).toBeCloseTo(2 / 3, 9);
    expect(readoutOf(s, "oven")).toMatchObject({
      reason: "BOTTLENECK",
      wants: expect.closeTo(3, 9),
    });
    expect(readoutOf(s, "tower")).toMatchObject({
      reason: "STARVED",
      port: ref("tower", 0, true),
      upstream: ["oven"],
    });
  });

  it("two Up to consumers an Exactly producer cannot both feed: equal levels, both STARVED", () => {
    const s = solved(sharedProducer(1)).solution;
    expect(s.machineCounts["c1"]).toBeCloseTo(0.5, 9);
    expect(s.machineCounts["c2"]).toBeCloseTo(0.5, 9);
    for (const c of ["c1", "c2"]) {
      const r = readoutOf(s, c);
      expect(r).toMatchObject({ reason: "STARVED", port: ref(c, 0, true) });
      // The producer is pinned Exactly: no Up to card upstream to act on.
      expect(r.upstream).toBeUndefined();
    }
    expect(s.gatedSinks).toEqual([]);
  });

  it("stage A runs first: the consumer that does more with the same supply runs full (plain max-min: both at a third)", () => {
    const s = solved(sharedProducer(2)).solution;
    expect(s.machineCounts["c1"]).toBeCloseTo(1, 9);
    expect(s.machineCounts["c2"]).toBeCloseTo(0, 9);
    expect(readoutOf(s, "c1").reason).toBe("FULL");
    expect(readoutOf(s, "c2")).toMatchObject({
      reason: "STARVED",
      port: ref("c2", 0, true),
      reached: expect.closeTo(0, 9),
    });
    expect(s.unneeded).toEqual([]);
  });

  it("a drawer rate the Up to producer cannot reach falls short, names the card, and opens no forced input", () => {
    const s = solved(unreachableDrawer()).solution;
    expect(s.machineCounts["p"]).toBeCloseTo(2, 6);
    expect(s.machineCounts["c"]).toBeCloseTo(2, 6);
    expect(s.gatedSources).toEqual([]);
    expect(s.gatedSinks).toEqual([]);
    expect(s.drawers.unmet).toEqual(["d"]);
    expect(s.drawers.shortfalls).toEqual([
      {
        drawer: "d",
        rule: "AT_LEAST",
        target: 5,
        reachable: expect.closeTo(2, 6),
        limitingNodes: ["p"],
        limitingDrawers: [],
        limitingGroups: 0,
      },
    ]);
    const limited = s.notes
      .filter((n) => n.message === "DRAWER_LIMITED_BY")
      .map((n) => n.args[1] as Note);
    expect(limited).toEqual([
      { message: "LIMIT_PIN", args: ["p", { message: "PIN_UP_TO", args: [] }] },
    ]);
    // What it would take to meet the drawer.
    expect(readoutOf(s, "p")).toMatchObject({ reason: "BOTTLENECK", wants: expect.closeTo(5, 6) });
  });

  it("an Exactly consumer downstream of an Up to producer: the gap is a forced input, and the producer wants it", () => {
    const s = solved(exactConsumer()).solution;
    expect(s.machineCounts["p"]).toBeCloseTo(2, 9);
    expect(s.gatedSources).toEqual([
      { port: ref("c", 0, true), ratePerSecond: expect.closeTo(1, 9) },
    ]);
    expect(readoutOf(s, "p")).toMatchObject({
      reason: "BOTTLENECK",
      reached: expect.closeTo(2, 9),
      wants: expect.closeTo(3, 9),
    });
  });

  it("an Exactly producer upstream of an Up to consumer: its surplus is a forced output, the consumer FULL", () => {
    const s = solved(exactProducer()).solution;
    expect(s.machineCounts["u"]).toBeCloseTo(2, 9);
    expect(s.gatedSinks).toEqual([
      { port: ref("e", 0, false), ratePerSecond: expect.closeTo(1, 9) },
    ]);
    expect(readoutOf(s, "u").reason).toBe("FULL");
  });

  it("only Up to counts: the plan is anchored (no NO_PIN) and nothing in it is unneeded", () => {
    expect(new SolveContext(onlyUpTo()).anchored).toBe(true);
    const s = solved(onlyUpTo()).solution;
    expect(s.machineCounts["p"]).toBeCloseTo(2, 9);
    expect(s.machineCounts["q"]).toBeCloseTo(2, 9);
    expect(s.unneeded).toEqual([]);
    expect(readoutOf(s, "p").reason).toBe("FULL");
  });

  it("an Up to machine with no wires runs at its count: FULL", () => {
    const s = solved(unwired()).solution;
    expect(s.upTo).toEqual([
      { node: "m", machines: ["m"], capacity: 3, reached: expect.closeTo(3, 9), reason: "FULL" },
    ]);
  });

  it("a machine nothing takes from: UNUSED at zero, and never in unneeded", () => {
    const s = solved(nothingTakes()).solution;
    expect(s.machineCounts["m"]).toBe(0);
    expect(s.unneeded).toEqual([]);
    expect(readoutOf(s, "m")).toMatchObject({
      reason: "UNUSED",
      reached: 0,
      port: ref("m", 0, false),
    });
  });

  it("a shared Up to machine runs at its capacity across its recipes", () => {
    const s = solved(sharedPool()).solution;
    expect(s.machineCounts["lathe"]).toBeCloseTo(4 / 3, 9);
    expect(s.machineCounts["assembler"]).toBeCloseTo(8 / 3, 9);
    expect(s.upTo).toEqual([
      {
        node: "lathe",
        machines: ["lathe", "assembler"],
        capacity: 4,
        reached: expect.closeTo(4, 9),
        reason: "FULL",
      },
    ]);
  });

  it("a three-step chain held by its last step: both feeders CLOGGED, not pinned from both sides", () => {
    const s = solved(chain3()).solution;
    for (const id of ["a", "b"]) {
      expect(s.machineCounts[id]).toBeCloseTo(1, 9);
      expect(readoutOf(s, id)).toMatchObject({ reason: "CLOGGED", port: ref(id, 0, false) });
    }
    expect(readoutOf(s, "c").reason).toBe("FULL");
  });

  it("capped drawers on unwired ports: lifting a source's cap shows STARVED, a product's cap CLOGGED", () => {
    const s = solved(cappedDrawers()).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(1, 9);
    expect(s.machineCounts["n"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "m")).toMatchObject({ reason: "STARVED", port: ref("m", 0, true) });
    expect(readoutOf(s, "n")).toMatchObject({ reason: "CLOGGED", port: ref("n", 0, false) });
  });

  it("a plan without Up to pools has no read-out", () => {
    const i = chain(2, 1);
    const s = solved({
      ...i,
      pools: i.pools.map((p) => ({ ...p, exact: true, upTo: false })),
    }).solution;
    expect("upTo" in s).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alternatives, islands, the pin diagnosis, the budget
// ---------------------------------------------------------------------------

describe("Up to: a drawer on a wired port is the player's own end", () => {
  it("a source drawer of any rate tops up a loop: the machine runs at its count, drawing the least that does it", () => {
    const s = solved(toppedLoop()).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(2, 9);
    expect(s.machineCounts["r"]).toBeCloseTo(2, 9);
    // r's half an x a craft goes back into m before anything is drawn (recycle before importing), none to the spare.
    expect(s.drawers.rates["top-up"]).toBeCloseTo(1, 9);
    expect(s.drawers.rates["spare"]).toBeCloseTo(0, 9);
    expect(s.edgeFlowsPerSecond["x"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "m")).toMatchObject({ reason: "BOTTLENECK", wants: expect.closeTo(3, 9) });
    expect(readoutOf(s, "r")).toMatchObject({
      reason: "STARVED",
      port: ref("r", 0, true),
      upstream: ["m"],
    });
  });

  it("the same where the trades settle it: they hold only forced flow, never the drawer's supply", () => {
    const s = solved(toppedLoopTrading()).solution;
    expect(s.gatedSinks).toEqual([
      { port: ref("e", 0, false), ratePerSecond: expect.closeTo(0.5, 9) },
    ]);
    expect(s.machineCounts["m"]).toBeCloseTo(2, 9);
    expect(s.machineCounts["r"]).toBeCloseTo(2, 9);
    expect(s.drawers.rates["top-up"]).toBeCloseTo(1, 9);
    expect(s.drawers.rates["spare"]).toBeCloseTo(0, 9);
  });

  it("a capped source drawer: the machine reaches what it allows, and is STARVED at the drawer's port", () => {
    const s = solved(toppedLoop("AT_MOST", 0.5)).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(1, 9);
    expect(s.machineCounts["r"]).toBeCloseTo(1, 9);
    expect(s.drawers.rates["top-up"]).toBeCloseTo(0.5, 9);
    expect(s.drawers.rates["spare"]).toBeCloseTo(0, 9);
    expect(readoutOf(s, "m")).toMatchObject({ reason: "STARVED", port: ref("m", 0, true) });
  });

  it("a byproduct drawer is permission to run: what a taker can use goes to it first (ship before banking)", () => {
    const any = solved(banked("any")).solution;
    expect(any.machineCounts["p"]).toBeCloseTo(2, 9);
    expect(any.machineCounts["q"]).toBeCloseTo(2, 9);
    expect(any.drawers.rates["spare"]).toBeCloseTo(0, 9);
    const full = solved(banked("upTo")).solution;
    expect(full.machineCounts["p"]).toBeCloseTo(2, 9);
    expect(full.machineCounts["q"]).toBeCloseTo(1, 9);
    expect(full.drawers.rates["spare"]).toBeCloseTo(1, 9);
    expect(readoutOf(full, "p").reason).toBe("FULL");
    expect(readoutOf(full, "q").reason).toBe("FULL");
  });

  it("the trade levels (and the alternatives' ranks) leave a drawer's ports out only with Up to pools", () => {
    const traded = (i: SolveInput) => {
      const ctx = new SolveContext(i);
      return { drawn: [...ctx.drawnPorts], ports: levels(ctx).flatMap((l) => l.ports) };
    };
    const up = traded(toppedLoop());
    expect(up.drawn).toHaveLength(2);
    for (const p of up.drawn) expect(up.ports).not.toContain(p);
    const exact = toppedLoop();
    const plain = traded({
      ...exact,
      pools: exact.pools.map((p) => ({ ...p, exact: true, upTo: false })),
    });
    for (const p of plain.drawn) expect(plain.ports).toContain(p);
  });
});

describe("Up to: a buffer of any rule banks what its takers do not take", () => {
  it("a slower Up to taker: the maker runs full, the taker full, the buffer banks the rest, nothing forced", () => {
    const s = solved(buffered("upTo")).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(2, 9);
    expect(s.machineCounts["t"]).toBeCloseTo(1, 9);
    expect(s.drawers.banked).toEqual({ buf: expect.closeTo(1, 9) });
    expect(s.drawers.rates["buf"]).toBeCloseTo(1, 9);
    expect(s.drawers.ports["buf"]).toEqual([
      { port: ref("m", 0, false), ratePerSecond: expect.closeTo(1, 9) },
      { port: ref("t", 0, true), ratePerSecond: expect.closeTo(1, 9) },
    ]);
    expect(s.gatedSinks).toEqual([]);
    expect(s.gatedSources).toEqual([]);
    expect(s.openGates).toBe(0);
    expect(readoutOf(s, "m").reason).toBe("FULL");
    expect(readoutOf(s, "t").reason).toBe("FULL");
  });

  it("a taker of any count takes all of it first (ship before banking): nothing banked", () => {
    const s = solved(buffered("any")).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(2, 9);
    expect(s.machineCounts["t"]).toBeCloseTo(2, 9);
    expect(s.drawers.banked).toEqual({ buf: 0 });
    expect(s.gatedSinks).toEqual([]);
  });

  it("a buffer with a rule keeps it over what passes through, and banks nothing", () => {
    const s = solved(buffered("upTo", "AT_MOST", 0.5)).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(0.5, 9);
    expect(s.machineCounts["t"]).toBeCloseTo(0.5, 9);
    expect(s.drawers.banked).toBeUndefined();
    expect(s.gatedSinks).toEqual([]);
    expect(readoutOf(s, "m").reason).toBe("CLOGGED");
  });

  it("without Up to pools a buffer is wiring only: no bank", () => {
    const i = buffered("upTo");
    const ctx = new SolveContext({
      ...i,
      pools: i.pools.map((p) => ({ ...p, exact: true, upTo: false })),
    });
    expect(ctx.bankPorts.size).toBe(0);
  });
});

describe("Up to: the reasons weigh the inputs against the outputs, as old Build does", () => {
  it("held at both ends at once: the input story first, STARVED; its feeder at full is a BOTTLENECK for it", () => {
    const s = solved(twoSided(1)).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "m")).toMatchObject({
      reason: "STARVED",
      port: ref("m", 0, true),
      upstream: ["s"],
    });
    // Nothing downstream of s could use more of it (m's output is capped too), but m is short of what s makes: s
    // wants what m would draw at its count.
    expect(readoutOf(s, "s")).toMatchObject({ reason: "BOTTLENECK", wants: expect.closeTo(2, 9) });
  });

  it("the output strictly tighter: CLOGGED at the capped output, and its feeder CLOGGED behind it", () => {
    const s = solved(twoSided(1.5)).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(1, 9);
    expect(s.machineCounts["s"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "m")).toMatchObject({ reason: "CLOGGED", port: ref("m", 0, false) });
    expect(readoutOf(s, "s")).toMatchObject({ reason: "CLOGGED", port: ref("s", 0, false) });
  });

  it("two producers short of one consumer: both are BOTTLENECKs, the consumer STARVED with both upstream", () => {
    const s = solved(twoProducers()).solution;
    expect(s.machineCounts["c"]).toBeCloseTo(2 / 3, 9);
    expect(readoutOf(s, "c")).toMatchObject({
      reason: "STARVED",
      port: ref("c", 0, true),
      upstream: ["p1", "p2"],
    });
    for (const p of ["p1", "p2"]) {
      expect(readoutOf(s, p)).toMatchObject({ reason: "BOTTLENECK", wants: expect.closeTo(2, 9) });
    }
  });
});

describe("Up to: rings that blame each other (dead loops and clog locks)", () => {
  it("a recycling ring nothing feeds is a DEAD_LOOP, two and three long, and a machine fed by itself", () => {
    for (const n of [1, 2, 3]) {
      const s = solved(deadRing(n)).solution;
      const ids = Array.from({ length: n }, (_, k) => `r${k}`);
      for (const id of ids) expect(readoutOf(s, id).reason).toBe("STARVED");
      expect(s.upToLoops).toEqual([
        { kind: "DEAD_LOOP", nodes: ids, ports: ids.map((id) => ref(id, 0, true)) },
      ]);
    }
  });

  it("a byproduct ring that fills its own way out is a CLOG_LOCK of its full outputs", () => {
    const s = solved(clogRing()).solution;
    expect(readoutOf(s, "a").reason).toBe("UNUSED");
    expect(readoutOf(s, "b").reason).toBe("UNUSED");
    expect(s.upToLoops).toEqual([
      { kind: "CLOG_LOCK", nodes: ["a", "b"], ports: [ref("a", 0, false), ref("b", 0, false)] },
    ]);
  });

  it("a recycling ring fed from outside runs, so it is no dead loop: the feed holds it back", () => {
    const s = solved(fedRing(0.25)).solution;
    for (const id of ["r0", "r1"]) {
      expect(readoutOf(s, id).reason).toBe("STARVED");
      expect(readoutOf(s, id).reached).toBeCloseTo(0.5, 6);
    }
    expect("upToLoops" in s).toBe(false);
  });

  it("a starved chain is no ring: no `upToLoops`", () => {
    const s = solved(starvedChain()).solution;
    expect(readoutOf(s, "a").reason).toBe("STARVED");
    expect(readoutOf(s, "b").reason).toBe("STARVED");
    expect("upToLoops" in s).toBe(false);
  });

  it("two islands: each island's rings, merged by their first member", () => {
    const s = solved(twoRings()).solution;
    expect(s.upToLoops!.map((l) => [l.kind, l.nodes])).toEqual([
      ["DEAD_LOOP", ["a0", "a1"]],
      ["DEAD_LOOP", ["b0", "b1", "b2"]],
    ]);
  });
});

describe("Up to: several ports short at once", () => {
  it("two inputs short together, neither alone: STARVED at the first, the other tied", () => {
    const s = solved(twoShortInputs()).solution;
    expect(s.machineCounts["m"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "m")).toMatchObject({
      reason: "STARVED",
      port: ref("m", 0, true),
      tied: [ref("m", 1, true)],
    });
  });

  it("two outputs full together, neither alone: CLOGGED at the first, the other tied", () => {
    const s = solved(twoFullOutputs()).solution;
    expect(s.machineCounts["n"]).toBeCloseTo(1, 9);
    expect(readoutOf(s, "n")).toMatchObject({
      reason: "CLOGGED",
      port: ref("n", 0, false),
      tied: [ref("n", 1, false)],
    });
  });
});

describe("Up to: wherever a support is settled", () => {
  it("the alternatives and the stored choice push: the Up to card stays at its count on every support", () => {
    const first = solved(withAlternatives());
    expect(first.solution.machineCounts["u"]).toBeCloseTo(3, 9);
    const other = first.alternatives.options.find((o) => o.rank !== "DEFAULT");
    expect(other).toBeDefined();
    expect(other!.opens).toEqual(ref("e", 0, false));

    // evaluateSupport pushes: without it least flow would leave u idle.
    const piece = solvePiece(withAlternatives(), planExtensions);
    const target = resolveChoice(piece.ctx, other!.key.gateAnchors)!;
    const settled = evaluateSupportWith(piece.ctx, target)!;
    const u = piece.ctx.model.machineIndex.get("u")!;
    expect(piece.ctx.countOf(u, settled.point.extents[u]!)).toBeCloseTo(3, 9);
    expect(settled.trades.floors).toHaveLength(1);

    // The stored choice commits that support, pushed, and the read-out reads it.
    const chosen = solved(withAlternatives(other!.key.gateAnchors)).solution;
    expect(chosen.key).toEqual(other!.key);
    expect(chosen.machineCounts["a"]).toBeCloseTo(1, 9);
    expect(chosen.machineCounts["u"]).toBeCloseTo(3, 9);
    expect(readoutOf(chosen, "u").reason).toBe("FULL");
  });

  it("two islands: each island's read-out is its own, merged by node", () => {
    const s = solved(twoIslands()).solution;
    expect(s.upTo!.map((r) => r.node)).toEqual(["a1", "a2", "b1", "b2"]);
    const one = solved(chain(2, 1)).solution;
    const two = solved(chain(1, 3)).solution;
    const renamed = (r: UpToReadout, suffix: string): UpToReadout =>
      JSON.parse(JSON.stringify(r).replace(/"([ab])"/g, `"$1${suffix}"`)) as UpToReadout;
    expect(differences(readoutOf(s, "a1"), renamed(readoutOf(one, "a"), "1"))).toEqual([]);
    expect(differences(readoutOf(s, "b1"), renamed(readoutOf(one, "b"), "1"))).toEqual([]);
    expect(differences(readoutOf(s, "a2"), renamed(readoutOf(two, "a"), "2"))).toEqual([]);
    expect(differences(readoutOf(s, "b2"), renamed(readoutOf(two, "b"), "2"))).toEqual([]);
    expect(readoutOf(s, "a2")).toMatchObject({ reason: "BOTTLENECK", wants: expect.closeTo(3, 9) });
  });

  it("a drawer shortfall is never a pin conflict: the pin diagnosis runs without the guard", () => {
    // e (Exactly 1) and p (Up to 2) feed c; a drawer asks 5 of c's output; f (Exactly 1) is a second pin on the island.
    const i = pinDiagnosis();
    const stalled = runChain(new SolveContext(i));
    expect(stalled.kind).toBe("stalled");
    if (stalled.kind === "stalled") expect(findNote(stalled.reason, "PIN_CONFLICT")).toBeNull();
    const s = solved(i).solution;
    expect(s.machineCounts["c"]).toBeCloseTo(3, 6);
    expect(s.gatedSources).toEqual([]);
    expect(s.drawers.shortfalls[0]!.limitingNodes).toEqual(["e", "p"]);
  });

  it("the read-out's work is counted: past its budget a reason is null, in pool order", () => {
    // Ten consumers (Up to 1) each take one of twelve goods a craft from twelve Exactly producers making five a second:
    // each consumer runs at half, short of all twelve together, and its reason takes thirteen models (inputs fed, then
    // each input alone), more than its allowance: the budget (96) runs out on the eighth.
    const ids = Array.from({ length: 10 }, (_, k) => `c${String(k).padStart(2, "0")}`);
    const i = budgetPlan();
    expect(readoutBudget(ids.length)).toBe(MAX_READOUT_LPS);
    const s = solved(i).solution;
    const reasons = ids.map((id) => readoutOf(s, id).reason);
    expect(reasons).toEqual([...Array<string>(7).fill("STARVED"), null, null, null]);
    for (const id of ids) expect(s.machineCounts[id]).toBeCloseTo(0.5, 9);
  });
});

// ---------------------------------------------------------------------------
// Determinism and work
// ---------------------------------------------------------------------------

describe("Up to: determinism and work", () => {
  const cases: Array<[string, () => SolveInput]> = [
    ...Object.entries(FIXTURES),
    ...CORPUS_UP_TO.map((name): [string, () => SolveInput] => [
      `${name}, every count Up to`,
      () => everyCountUpTo(loadInput(name)),
    ]),
  ];

  it.each(cases)(
    "%s answers the same solved again and built in reverse column order",
    (_name, make) => {
      const i = make();
      const first = solvePlan(i);
      const again = solvePlan(i);
      setColumnOrder("reverse");
      let reversed: Answer;
      try {
        reversed = solvePlan(i);
      } finally {
        setColumnOrder("forward");
      }
      expect(first.kind).toBe("solved");
      for (const other of [again, reversed]) expect(differences(first, other, 5)).toEqual([]);
    },
  );

  it("counts its work: the same plan runs the same number of LPs, and few of them", () => {
    const counts: Record<string, number> = {};
    for (const [name, make] of Object.entries(FIXTURES)) {
      const i = make();
      takeLpCount();
      solvePlan(i);
      const n = takeLpCount();
      solvePlan(i);
      expect(takeLpCount(), name).toBe(n);
      counts[name] = n;
    }
    // A drawer that carries flow opens a gate, so the alternatives search tries swaps, and each support it settles is
    // pushed again (about ten models): the topped loops' swaps are most of their counts.
    for (const [name, n] of Object.entries(counts)) expect(n, name).toBeLessThanOrEqual(64);
  });
});
