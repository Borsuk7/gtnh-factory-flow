/**
 * The hand-built Up to plans (docs/up-to.md) shared by `upto.test.ts` and the parity export (`parity/up-to-export.test.ts`,
 * which hands them to the mod's solver). Every machine runs a craft a second per machine unless it says otherwise.
 */
import type { EdgeIn, MachineIn, PoolIn, PortRef, SolveInput, DrawerRule } from "../../types";

export const port = (resource: number, name: string, amount = 1) => ({
  amount,
  chance: 1,
  multiplier: 1,
  resource,
  name,
  free: false,
});

/** `exact` > 0 pins the count exactly (`countFixed`); an Up to count is a pool (`upTo`). */
export function machine(
  id: string,
  inputs: ReturnType<typeof port>[],
  outputs: ReturnType<typeof port>[],
  exact = 0,
  durationTicks = 20,
): MachineIn {
  return {
    id,
    name: id,
    durationTicks,
    energyPerTick: 0,
    throughputFactor: 1,
    inputs,
    outputs,
    countFixed: exact > 0,
    machineCount: Math.max(1, exact),
    targetOutputRates: {},
    targetInputRates: {},
  };
}

export const edge = (
  id: string,
  source: string,
  sourceOutput: number,
  target: string,
  targetInput: number,
): EdgeIn => ({
  id,
  source,
  sourceOutput,
  target,
  targetInput,
});

export const upTo = (machines: string[], capacity: number): PoolIn => ({
  machines,
  capacity,
  exact: false,
  upTo: true,
});

export function plan(
  machines: MachineIn[],
  edges: EdgeIn[],
  pools: PoolIn[],
  extra: Partial<SolveInput> = {},
): SolveInput {
  return {
    mode: "AUTO",
    choice: null,
    machines,
    edges,
    pools,
    drawers: [],
    extentPins: {},
    spares: {},
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The plans
// ---------------------------------------------------------------------------

/** a (Up to `first`, ore -> x) -> b (Up to `second`, x -> y); ore and y are free ends. */
export const chain = (first: number, second: number): SolveInput =>
  plan(
    [machine("a", [port(9, "ore")], [port(1, "x")]), machine("b", [port(1, "x")], [port(2, "y")])],
    [edge("e1", "a", 0, "b", 0)],
    [upTo(["a"], first), upTo(["b"], second)],
  );

/** a (Up to 2) -> b (Up to 2) -> c (Up to 1). */
export const chain3 = (): SolveInput =>
  plan(
    [
      machine("a", [port(9, "ore")], [port(1, "x")]),
      machine("b", [port(1, "x")], [port(2, "y")]),
      machine("c", [port(2, "y")], [port(3, "z")]),
    ],
    [edge("e1", "a", 0, "b", 0), edge("e2", "b", 0, "c", 0)],
    [upTo(["a"], 2), upTo(["b"], 2), upTo(["c"], 1)],
  );

/** m (Up to 2) draws its ore from a source giving at most 1/s; n (Up to 2) sends its gears to a product taking at most 1/s. */
export const cappedDrawers = (): SolveInput =>
  plan(
    [
      machine("m", [port(9, "ore")], [port(1, "x")]),
      machine("n", [port(8, "dust")], [port(2, "gear")]),
    ],
    [],
    [upTo(["m"], 2), upTo(["n"], 2)],
    {
      drawers: [
        {
          id: "ore",
          label: "ore",
          kind: "SOURCE",
          rule: "AT_MOST",
          rate: 1,
          links: [{ node: "m", port: 0 }],
        },
        {
          id: "gear",
          label: "gear",
          kind: "PRODUCT",
          rule: "AT_MOST",
          rate: 1,
          links: [{ node: "n", port: 0 }],
        },
      ],
    },
  );

/**
 * Two pyrolyse ovens (32 s, 20 tar a craft: 0.625 tar/s each) feed a distillation tower (1 s, 1.875 tar a craft) that
 * could take half as much again as they make.
 */
export const benzene = (): SolveInput =>
  plan(
    [
      machine("oven", [port(9, "logs", 16)], [port(1, "wood tar", 20)], 0, 640),
      machine("tower", [port(1, "wood tar", 1.875)], [port(2, "benzene")]),
    ],
    [edge("tar", "oven", 0, "tower", 0)],
    [upTo(["oven"], 2), upTo(["tower"], 1)],
  );

/** An Exactly producer of 1 x/s feeding two Up to 1 consumers; c2 takes `c2Takes` x a craft. */
export const sharedProducer = (c2Takes: number): SolveInput =>
  plan(
    [
      machine("c1", [port(1, "x")], [port(2, "y")]),
      machine("c2", [port(1, "x", c2Takes)], [port(3, "z")]),
      machine("e", [], [port(1, "x")], 1),
    ],
    [edge("e1", "e", 0, "c1", 0), edge("e2", "e", 0, "c2", 0)],
    [upTo(["c1"], 1), upTo(["c2"], 1)],
  );

/** p (Up to 2, ore -> x) -> c (any count, x -> y), with a product drawer asking at least 5 y/s. */
export const unreachableDrawer = (): SolveInput =>
  plan(
    [machine("c", [port(1, "x")], [port(2, "y")]), machine("p", [port(9, "ore")], [port(1, "x")])],
    [edge("e1", "p", 0, "c", 0)],
    [upTo(["p"], 2)],
    {
      drawers: [
        {
          id: "d",
          label: "y",
          kind: "PRODUCT",
          rule: "AT_LEAST",
          rate: 5,
          links: [{ node: "c", port: 0 }],
        },
      ],
    },
  );

/** p (Up to 2) -> c (Exactly 3). */
export const exactConsumer = (): SolveInput =>
  plan(
    [
      machine("c", [port(1, "x")], [port(2, "y")], 3),
      machine("p", [port(9, "ore")], [port(1, "x")]),
    ],
    [edge("e1", "p", 0, "c", 0)],
    [upTo(["p"], 2)],
  );

/** e (Exactly 3) -> u (Up to 2). */
export const exactProducer = (): SolveInput =>
  plan(
    [
      machine("e", [port(9, "ore")], [port(1, "x")], 3),
      machine("u", [port(1, "x")], [port(2, "y")]),
    ],
    [edge("e1", "e", 0, "u", 0)],
    [upTo(["u"], 2)],
  );

/** p (Up to 2) -> q (any count). */
export const onlyUpTo = (): SolveInput =>
  plan(
    [machine("p", [port(9, "ore")], [port(1, "x")]), machine("q", [port(1, "x")], [port(2, "y")])],
    [edge("e1", "p", 0, "q", 0)],
    [upTo(["p"], 2)],
  );

export const unwired = (): SolveInput =>
  plan([machine("m", [port(9, "ore")], [port(1, "gear")])], [], [upTo(["m"], 3)]);

/** c (Exactly 1) takes all it needs from e (Exactly 1); m (Up to 2) makes x for c too. */
export const nothingTakes = (): SolveInput =>
  plan(
    [
      machine("c", [port(1, "x")], [port(2, "y")], 1),
      machine("e", [], [port(1, "x")], 1),
      machine("m", [port(9, "ore")], [port(1, "x")]),
    ],
    [edge("e1", "m", 0, "c", 0), edge("e2", "e", 0, "c", 0)],
    [upTo(["m"], 2)],
  );

/** A shared machine: a lathe (ore -> 2 gears) and an assembler (gear -> kit) sharing up to 4 machines. */
export const sharedPool = (): SolveInput =>
  plan(
    [
      machine("assembler", [port(1, "gear")], [port(2, "kit")]),
      machine("lathe", [port(0, "ore")], [port(1, "gear", 2)]),
    ],
    [edge("gear", "lathe", 0, "assembler", 0)],
    [upTo(["lathe", "assembler"], 4)],
  );

/**
 * e (Exactly 1) makes 2 x/s; a (any count) turns x into y; b (Exactly 1) takes 1 y/s. The spare leaves at a's output
 * (the default) or at e's (the alternative). u (Up to 3, free ends) shares e's seed drawer, so it is on the same island.
 */
export const withAlternatives = (choice: PortRef[] | null = null): SolveInput =>
  plan(
    [
      machine("a", [port(1, "x")], [port(2, "y")]),
      machine("b", [port(2, "y")], [port(3, "z")], 1),
      machine("e", [port(8, "seed")], [port(1, "x", 2)], 1),
      machine("u", [port(8, "seed")], [port(4, "w")]),
    ],
    [edge("e1", "e", 0, "a", 0), edge("e2", "a", 0, "b", 0)],
    [upTo(["u"], 3)],
    {
      choice,
      drawers: [
        {
          id: "seed",
          label: "seed",
          kind: "SOURCE",
          rule: "ANY",
          rate: 0,
          links: [
            { node: "e", port: 0 },
            { node: "u", port: 0 },
          ],
        },
      ],
    },
  );

/** chain(2, 1) and chain(1, 3) side by side, ids interleaved. */
export const twoIslands = (): SolveInput =>
  plan(
    [
      machine("a1", [port(9, "ore")], [port(1, "x")]),
      machine("a2", [port(9, "ore")], [port(1, "x")]),
      machine("b1", [port(1, "x")], [port(2, "y")]),
      machine("b2", [port(1, "x")], [port(2, "y")]),
    ],
    [edge("e1", "a1", 0, "b1", 0), edge("e2", "a2", 0, "b2", 0)],
    [upTo(["a1"], 2), upTo(["a2"], 1), upTo(["b1"], 1), upTo(["b2"], 3)],
  );

/**
 * Old Build's loop top-up, converted: m (Up to 2, x -> y) and r (Up to 3, y -> half an x) in a loop on the x wire, with
 * a source drawer (`rule`, `rate`) on m's x input and a byproduct drawer on r's x output, both on wired ports.
 */
export const toppedLoop = (rule: DrawerRule = "ANY", rate = 0): SolveInput =>
  plan(
    [
      machine("m", [port(1, "x")], [port(2, "y")]),
      machine("r", [port(2, "y")], [port(1, "x", 0.5)]),
    ],
    [edge("y", "m", 0, "r", 0), edge("x", "r", 0, "m", 0)],
    [upTo(["m"], 2), upTo(["r"], 3)],
    {
      drawers: [
        { id: "top-up", label: "x", kind: "SOURCE", rule, rate, links: [{ node: "m", port: 0 }] },
        {
          id: "spare",
          label: "x",
          kind: "BYPRODUCT",
          rule: "ANY",
          rate: 0,
          links: [{ node: "r", port: 0 }],
        },
      ],
    },
  );

/**
 * The topped loop on an island that must also trade, so the fast path cannot settle it and the trades do: e (Exactly 1)
 * makes 1 z/s for k (Exactly 1, half a z a craft), the spare half sold at e. A seed drawer of any rate on e's and r's
 * unwired inputs puts them on one island.
 */
export const toppedLoopTrading = (): SolveInput => {
  const loop = toppedLoop();
  return {
    ...loop,
    machines: [
      machine("e", [port(8, "seed")], [port(5, "z")], 1),
      machine("k", [port(5, "z", 0.5)], [], 1),
      loop.machines[0]!,
      { ...loop.machines[1]!, inputs: [...loop.machines[1]!.inputs, port(8, "seed")] },
    ],
    edges: [...loop.edges, edge("z", "e", 0, "k", 0)],
    drawers: [
      ...loop.drawers,
      {
        id: "seed",
        label: "seed",
        kind: "SOURCE",
        rule: "ANY",
        rate: 0,
        links: [
          { node: "e", port: 0 },
          { node: "r", port: 1 },
        ],
      },
    ],
  };
};

/** p (Up to 2, ore -> x) -> `taker` (x -> y), with a byproduct drawer on p's wired x output. */
export const banked = (taker: "any" | "upTo"): SolveInput =>
  plan(
    [machine("p", [port(9, "ore")], [port(1, "x")]), machine("q", [port(1, "x")], [port(2, "y")])],
    [edge("e1", "p", 0, "q", 0)],
    taker === "upTo" ? [upTo(["p"], 2), upTo(["q"], 1)] : [upTo(["p"], 2)],
    {
      drawers: [
        {
          id: "spare",
          label: "x",
          kind: "BYPRODUCT",
          rule: "ANY",
          rate: 0,
          links: [{ node: "p", port: 0 }],
        },
      ],
    },
  );

/** m (Up to 2, ore -> x) puts its x into a buffer (`rule`, `rate`) that t (x -> y; Up to 1 or any count) draws from. */
export const buffered = (taker: "upTo" | "any", rule: DrawerRule = "ANY", rate = 0): SolveInput =>
  plan(
    [machine("m", [port(9, "ore")], [port(1, "x")]), machine("t", [port(1, "x")], [port(2, "y")])],
    [],
    taker === "upTo" ? [upTo(["m"], 2), upTo(["t"], 1)] : [upTo(["m"], 2)],
    {
      drawers: [
        {
          id: "buf",
          label: "x",
          kind: "BUFFER",
          rule,
          rate,
          links: [{ node: "m", port: 0 }],
          takers: [{ node: "t", port: 0 }],
        },
      ],
    },
  );

/**
 * s (Up to `feeder`, ore -> x) feeds m (Up to 2, x -> y), whose y goes to a product drawer taking at most 1/s. With
 * `feeder` 1, m is held at half by both ends at once; with 1.5 its output is the tighter.
 */
export const twoSided = (feeder: number): SolveInput =>
  plan(
    [machine("m", [port(1, "x")], [port(2, "y")]), machine("s", [port(9, "ore")], [port(1, "x")])],
    [edge("x", "s", 0, "m", 0)],
    [upTo(["m"], 2), upTo(["s"], feeder)],
    {
      drawers: [
        {
          id: "out",
          label: "y",
          kind: "PRODUCT",
          rule: "AT_MOST",
          rate: 1,
          links: [{ node: "m", port: 0 }],
        },
      ],
    },
  );

/** p1 and p2 (Up to 1, 1 x/s each) feed c (Up to 1, 3 x a craft): c could take half as much again as both make. */
export const twoProducers = (): SolveInput =>
  plan(
    [
      machine("c", [port(1, "x", 3)], [port(2, "y")]),
      machine("p1", [port(9, "ore")], [port(1, "x")]),
      machine("p2", [port(9, "ore")], [port(1, "x")]),
    ],
    [edge("x1", "p1", 0, "c", 0), edge("x2", "p2", 0, "c", 0)],
    [upTo(["c"], 1), upTo(["p1"], 1), upTo(["p2"], 1)],
  );

/** m (Up to 2) takes x and w, 1 a craft each, from e1 and e2 (Exactly 1, 1/s each): both inputs short at once. */
export const twoShortInputs = (): SolveInput =>
  plan(
    [
      machine("e1", [], [port(1, "x")], 1),
      machine("e2", [], [port(2, "w")], 1),
      machine("m", [port(1, "x"), port(2, "w")], [port(3, "y")]),
    ],
    [edge("x", "e1", 0, "m", 0), edge("w", "e2", 0, "m", 1)],
    [upTo(["m"], 2)],
  );

/** n (Up to 2) makes y and v, 1 a craft each, for c1 and c2 (Exactly 1, 1/s each): both outputs full at once. */
export const twoFullOutputs = (): SolveInput =>
  plan(
    [
      machine("c1", [port(2, "y")], [], 1),
      machine("c2", [port(3, "v")], [], 1),
      machine("n", [port(9, "ore")], [port(2, "y"), port(3, "v")]),
    ],
    [edge("y", "n", 0, "c1", 0), edge("v", "n", 1, "c2", 0)],
    [upTo(["n"], 2)],
  );

/**
 * A recycling ring of `n` Up to 1 machines nothing feeds (`${prefix}0`: x0 -> x1, ..., the last back to x0 at half a
 * craft's worth): every member starved by the one before it, a dead loop (with `n` 1, a machine fed by its own output).
 */
export const deadRing = (n: number, prefix = "r"): SolveInput => {
  const ids = Array.from({ length: n }, (_, k) => `${prefix}${k}`);
  return plan(
    ids.map((id, k) =>
      machine(
        id,
        [port(k, `x${k}`)],
        [port((k + 1) % n, `x${(k + 1) % n}`, k === n - 1 ? 0.5 : 1)],
      ),
    ),
    ids.map((id, k) => edge(`${prefix}w${k}`, id, 0, ids[(k + 1) % n]!, 0)),
    ids.map((id) => upTo([id], 1)),
  );
};

/**
 * The dead ring of two fed from outside: e (Exactly 1) puts `feed` x0 a second into r0. With 0.25 the ring runs at half
 * its counts, both starved, held back by the feed: it is no dead loop.
 */
export const fedRing = (feed: number): SolveInput => {
  const ring = deadRing(2);
  return {
    ...ring,
    machines: [...ring.machines, machine("e", [], [port(0, "x0", feed)], 1)],
    edges: [...ring.edges, edge("rfeed", "e", 0, "r0", 0)],
  };
};

/**
 * a (x and free ore -> y) and b (y -> 2 x), both Up to 1, in a ring: b makes twice the x a takes, with nowhere for the
 * rest to go, so neither runs: a clog lock (the fix is a drawer on b's x).
 */
export const clogRing = (): SolveInput =>
  plan(
    [
      machine("a", [port(1, "x"), port(9, "ore")], [port(2, "y")]),
      machine("b", [port(2, "y")], [port(1, "x", 2)]),
    ],
    [edge("y", "a", 0, "b", 0), edge("x", "b", 0, "a", 0)],
    [upTo(["a"], 1), upTo(["b"], 1)],
  );

/** e (Exactly 1) -> a (Up to 2) -> b (Up to 2): both starved, b by a, a by e; no ring. */
export const starvedChain = (): SolveInput =>
  plan(
    [
      machine("a", [port(1, "x")], [port(2, "y")]),
      machine("b", [port(2, "y")], [port(3, "z")]),
      machine("e", [], [port(1, "x")], 1),
    ],
    [edge("x", "e", 0, "a", 0), edge("y", "a", 0, "b", 0)],
    [upTo(["a"], 2), upTo(["b"], 2)],
  );

/** A dead ring of two (a0, a1) and one of three (b0, b1, b2), two islands. */
export const twoRings = (): SolveInput => {
  const one = deadRing(2, "a");
  const two = deadRing(3, "b");
  return {
    ...one,
    machines: [...one.machines, ...two.machines],
    edges: [...one.edges, ...two.edges],
    pools: [...one.pools, ...two.pools],
  };
};

export const FIXTURES: Record<string, () => SolveInput> = {
  "chain, second slower": () => chain(2, 1),
  "chain, first slower": () => chain(2, 3),
  "chain of three": chain3,
  "capped drawers": cappedDrawers,
  benzene,
  "shared producer": () => sharedProducer(1),
  "stage A": () => sharedProducer(2),
  "unreachable drawer": unreachableDrawer,
  "exact consumer": exactConsumer,
  "exact producer": exactProducer,
  "only Up to": onlyUpTo,
  unwired,
  "nothing takes": nothingTakes,
  "shared pool": sharedPool,
  alternatives: () => withAlternatives(),
  "two islands": twoIslands,
  "topped loop": () => toppedLoop(),
  "topped loop, capped": () => toppedLoop("AT_MOST", 0.5),
  "topped loop, trading": toppedLoopTrading,
  "banked, any taker": () => banked("any"),
  "banked, Up to taker": () => banked("upTo"),
  "buffer, Up to taker": () => buffered("upTo"),
  "buffer, any taker": () => buffered("any"),
  "buffer with a rule": () => buffered("upTo", "AT_MOST", 0.5),
  "two-sided, tied": () => twoSided(1),
  "two-sided, output tighter": () => twoSided(1.5),
  "two producers": twoProducers,
  "two short inputs": twoShortInputs,
  "two full outputs": twoFullOutputs,
  "dead ring of one": () => deadRing(1),
  "dead ring of two": () => deadRing(2),
  "dead ring of three": () => deadRing(3),
  "fed ring": () => fedRing(0.25),
  "clog ring": clogRing,
  "starved chain": starvedChain,
  "two rings": twoRings,
};

/** e (Exactly 1) and p (Up to 2) feed c; a drawer asks 5 of c's output; f (Exactly 1) is a second pin on the island. */
export function pinDiagnosis(): SolveInput {
  return plan(
    [
      machine("c", [port(1, "x")], [port(2, "y")]),
      machine("e", [port(8, "seed")], [port(1, "x")], 1),
      machine("f", [port(8, "seed")], [port(5, "v")], 1),
      machine("p", [port(9, "ore")], [port(1, "x")]),
    ],
    [edge("e1", "e", 0, "c", 0), edge("e2", "p", 0, "c", 0)],
    [upTo(["p"], 2)],
    {
      drawers: [
        {
          id: "d",
          label: "y",
          kind: "PRODUCT",
          rule: "AT_LEAST",
          rate: 5,
          links: [{ node: "c", port: 0 }],
        },
        {
          id: "seed",
          label: "seed",
          kind: "SOURCE",
          rule: "ANY",
          rate: 0,
          links: [
            { node: "e", port: 0 },
            { node: "f", port: 0 },
          ],
        },
      ],
    },
  );
}

/**
 * Ten consumers (Up to 1) each take one of twelve goods a craft from twelve Exactly producers making five a second:
 * each runs at half, short of all twelve together, and the read-out's budget runs out on the eighth.
 */
export function budgetPlan(): SolveInput {
  const goods = Array.from({ length: 12 }, (_, k) => k + 1);
  const ids = Array.from({ length: 10 }, (_, k) => `c${String(k).padStart(2, "0")}`);
  return plan(
    [
      ...ids.map((id) =>
        machine(
          id,
          goods.map((g) => port(g, `g${g}`)),
          [port(99, "y")],
        ),
      ),
      ...goods.map((g) => machine(`p${String(g).padStart(2, "0")}`, [], [port(g, `g${g}`)], 5)),
    ],
    ids.flatMap((id) =>
      goods.map((g) => edge(`w${id}-${g}`, `p${String(g).padStart(2, "0")}`, 0, id, g - 1)),
    ),
    ids.map((id) => upTo([id], 1)),
  );
}

/** A corpus plan with every exact count turned into an Up to count. */
export function everyCountUpTo(i: SolveInput): SolveInput {
  const pools = [...i.pools];
  const machines = i.machines.map((m) => {
    if (!m.countFixed || !(m.machineCount > 0)) return m;
    pools.push(upTo([m.id], m.machineCount));
    return { ...m, countFixed: false };
  });
  return { ...i, machines, pools };
}

export const CORPUS_UP_TO = [
  "oxygen-silicon-loop",
  "titanium-line-tour",
  "glass",
  "buffer-drawers",
  "gtnh-flow-two_decisions",
];
