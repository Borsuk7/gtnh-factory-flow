import { afterEach, describe, expect, it } from "vitest";
import { calculateThroughput } from "../../throughput";
import type { Answer, SolutionView, SolveInput } from "../types";
import type { FactoryProject, ThroughputResult } from "../../../model/types";
import { createCustomRatePlaceholderRecipe } from "../../../model/custom-rate";
import { setSolveCore } from "./engine";
import type { PlanSolveInput } from "./model";
import { customRecipe, drawer, handle, node, project, recipe, wire } from "./test-kit";

afterEach(() => setSolveCore(undefined));

const idle = { rates: {}, unmet: [], shortfalls: [], ports: {} };

function view(partial: Partial<SolutionView> = {}): SolutionView {
  return {
    extentsPerSecond: {},
    machineCounts: {},
    edgeFlowsPerSecond: {},
    gatedSources: [],
    gatedSinks: [],
    terminalInputs: [],
    terminalOutputs: [],
    unneeded: [],
    openGates: 0,
    externalQuantity: 0,
    totalInternalFlow: 0,
    notes: [],
    key: { gateAnchors: [] },
    drawers: idle,
    spares: [],
    ...partial,
  };
}

function solved(partial: Partial<SolutionView>): Answer {
  return {
    kind: "solved",
    solution: view(partial),
    alternatives: { chosen: null, options: [], complete: true, notes: [] },
  };
}

/** Runs the project with a core that records its input and answers as told. */
function run(
  p: FactoryProject,
  answer: (input: PlanSolveInput) => Answer = () => ({
    kind: "failed",
    failure: { message: "NO_PIN", args: [] },
    notes: [],
    drawers: idle,
  }),
): { input: PlanSolveInput; result: ThroughputResult } {
  let input!: PlanSolveInput;
  setSolveCore((i: SolveInput) => {
    input = i as PlanSolveInput;
    return answer(input);
  });
  const result = calculateThroughput(p, { generatedAt: "t" });
  return { input, result };
}

describe("shared machines", () => {
  const recipes = [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 2]], [["z", 1]])];
  const card = (extra = {}) => node("card", "a", { extraRecipes: [{ recipeId: "b" }], ...extra });
  const wires = [wire("e1", "card", "card", "y", { from: 0, to: 1 })];

  it("an Exactly card is one exact pool of its sections, none of them pinned alone", () => {
    const { input } = run(project({ recipes, nodes: [card({ solvePin: 2, solvePinExact: true })], edges: wires }));
    expect(input.machines.map((m) => m.id)).toEqual(["card", "card#r1"]);
    expect(input.pools).toEqual([{ machines: ["card", "card#r1"], capacity: 2, exact: true, upTo: false }]);
    expect(input.machines.every((m) => !m.countFixed)).toBe(true);
    // the wire joins the card's section 0 output to section 1's input
    expect(input.edges).toEqual([
      { id: "e1", source: "card", sourceOutput: 0, target: "card#r1", targetInput: 0 },
    ]);
  });

  it("an unpinned card makes no pool and no pin", () => {
    const { input } = run(project({ recipes, nodes: [card()], edges: wires }));
    expect(input.pools).toEqual([]);
    expect(input.machines.every((m) => !m.countFixed)).toBe(true);
  });

  it("a port rate stored with a section prefix lands on that section's machine", () => {
    const { input } = run(
      project({
        recipes,
        nodes: [card({ portRates: { [handle("output", "z", 1)]: 4, [handle("input", "x")]: 2 } })],
        edges: wires,
      }),
    );
    const [s0, s1] = input.machines;
    expect(s0!.targetInputRates).toEqual({ 0: 2 });
    expect(s0!.targetOutputRates).toEqual({});
    expect(s1!.targetOutputRates).toEqual({ 0: 4 });
  });

  it("a slot-indexed handle names the same row", () => {
    const { input } = run(
      project({ recipes, nodes: [node("n", "a", { portRates: { "output:item:y:3": 1.5 } })] }),
    );
    expect(input.machines[0]!.targetOutputRates).toEqual({ 0: 1.5 });
  });

  it("a rate on a row the recipe lacks is ignored", () => {
    const { input } = run(
      project({ recipes, nodes: [node("n", "a", { portRates: { "output:item:nope": 1 } })] }),
    );
    expect(input.machines[0]!.targetOutputRates).toEqual({});
  });
});

describe("pins, custom rate, disabled cards", () => {
  const recipes = [
    recipe("a", [["x", 2]], [["y", 4]]),
    customRecipe("rate", "y", 3, "supply"),
    createCustomRatePlaceholderRecipe("empty"),
  ];

  it("an Exactly pin is a fixed fractional count; zero is not a pin", () => {
    const { input } = run(
      project({
        recipes,
        nodes: [node("p", "a", { solvePin: 2.5, solvePinExact: true }), node("z", "a", { solvePin: 0 })],
      }),
    );
    const p = input.machines.find((m) => m.id === "p")!;
    expect([p.countFixed, p.machineCount]).toEqual([true, 2.5]);
    expect(input.machines.find((m) => m.id === "z")!.countFixed).toBe(false);
  });

  it("a custom rate card is pinned at its dial", () => {
    const { input } = run(
      project({
        recipes,
        nodes: [node("c", "rate"), node("c2", "rate", { solvePin: 2 })],
      }),
    );
    const c = input.machines.find((m) => m.id === "c")!;
    expect([c.countFixed, c.machineCount]).toEqual([true, 1]);
    // its per-craft amount is the dial (3 a second, a 20 tick craft)
    expect(c.outputs[0]!.amount).toBeCloseTo(3, 9);
    expect(input.machines.find((m) => m.id === "c2")!.machineCount).toBe(2);
  });

  it("a custom rate card holding nothing is left out", () => {
    const { input } = run(project({ recipes, nodes: [node("e", "empty")] }));
    expect(input.machines).toEqual([]);
  });

  it("a disabled card, its wires and a drawer left with no links are dropped", () => {
    const { input } = run(
      project({
        recipes: [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 1]], [["z", 1]])],
        nodes: [node("a", "a"), node("b", "b", { enabled: false })],
        storages: [drawer("out", "z"), drawer("in", "x")],
        edges: [
          wire("ab", "a", "b", "y"),
          wire("bz", "b", "out", "z", {}, { toDrawer: true }),
          wire("xa", "in", "a", "x", {}, { fromDrawer: true }),
        ],
      }),
    );
    expect(input.machines.map((m) => m.id)).toEqual(["a"]);
    expect(input.edges).toEqual([]);
    expect(input.drawers.map((d) => d.id)).toEqual(["in"]);
  });

  it("parallels fold into throughputFactor and the per-craft amount is the recipe's", () => {
    const { input } = run(
      project({ recipes, nodes: [node("p", "a", { parallel: 3, machineCount: 2 })] }),
    );
    const m = input.machines[0]!;
    expect(m.throughputFactor).toBe(3);
    expect(m.outputs[0]!.amount).toBeCloseTo(4, 9);
    // 2 machines x 3 parallel x 1 craft a second each: 24 y a second
    const rate = (2 * 20) / m.durationTicks;
    expect(rate * m.outputs[0]!.amount * m.throughputFactor).toBeCloseTo(4 * 2 * 3, 9);
  });

  it("a card with no built count still gets its recipe's amounts", () => {
    const { input } = run(project({ recipes, nodes: [node("p", "a", { machineCount: 0 })] }));
    expect(input.machines[0]!.inputs[0]!.amount).toBe(2);
    expect(input.machines[0]!.outputs[0]!.amount).toBe(4);
  });
});

describe("drawers", () => {
  const recipes = [recipe("a", [["x", 1]], [["y", 1]])];
  const base = (storages: ReturnType<typeof drawer>[], extra: string[] = []) =>
    project({
      recipes,
      nodes: [node("a", "a")],
      storages,
      edges: [
        wire("in", "src", "a", "x", {}, { fromDrawer: true }),
        ...extra.map((id) => wire(`out-${id}`, "a", id, "y", {}, { toDrawer: true })),
      ],
    });

  it("maps each target mode", () => {
    const cases: Array<[Parameters<typeof drawer>[2], string, number]> = [
      [{ targetPerSecond: 5, targetMode: "at-least" }, "AT_LEAST", 5],
      [{ targetPerSecond: 5, targetMode: "exact" }, "EXACTLY", 5],
      [{ targetPerSecond: 5, targetMode: "at-most" }, "AT_MOST", 5],
      [{ targetPerSecond: 5, targetMode: "ignore" }, "ANY", 0],
      [{}, "ANY", 0],
      [{ targetPerSecond: 0, targetMode: "at-least" }, "ANY", 0],
      [{ targetPerSecond: 0, targetMode: "at-most" }, "AT_MOST", 0],
    ];
    for (const [extra, rule, rate] of cases) {
      const { input } = run(base([drawer("src", "x"), drawer("o", "y", extra)], ["o"]));
      expect(input.drawers.find((d) => d.id === "o"), JSON.stringify(extra)).toMatchObject({
        rule,
        rate,
        kind: "PRODUCT",
      });
    }
  });

  it("an input drawer with a number defaults to exact; byproduct and trash numbers are dormant", () => {
    const p = base(
      [
        drawer("src", "x", { targetPerSecond: 4 }),
        drawer("bp", "y", { drainMode: "byproduct", targetPerSecond: 9, targetMode: "exact" }),
      ],
      ["bp"],
    );
    const { input } = run(p);
    expect(input.drawers.find((d) => d.id === "src")).toMatchObject({
      kind: "SOURCE",
      rule: "EXACTLY",
      rate: 4,
    });
    expect(input.drawers.find((d) => d.id === "bp")).toMatchObject({ kind: "PRODUCT", rule: "ANY" });
    const t = run(base([drawer("src", "x"), drawer("tr", "y", { drainMode: "trash" })], ["tr"]));
    expect(t.input.drawers.find((d) => d.id === "tr")).toMatchObject({ kind: "TRASH", rule: "ANY" });
  });

  it("a negative legacy number on a source is its magnitude", () => {
    const { input } = run(
      base([drawer("src", "x", { targetPerSecond: -6 }), drawer("o", "y")], ["o"]),
    );
    expect(input.drawers.find((d) => d.id === "src")).toMatchObject({ rule: "EXACTLY", rate: 6 });
  });

  it("a drawer wire carries what the port makes that its other wires do not", () => {
    const p = project({
      recipes: [recipe("a", [], [["y", 5]]), recipe("b", [["y", 2]], [])],
      nodes: [node("a", "a", { solvePin: 1 }), node("b", "b")],
      storages: [drawer("sink", "y")],
      edges: [wire("ab", "a", "b", "y"), wire("as", "a", "sink", "y", {}, { toDrawer: true })],
    });
    const { result } = run(p, () =>
      solved({
        extentsPerSecond: { a: 1, b: 1 },
        machineCounts: { a: 1, b: 1 },
        edgeFlowsPerSecond: { ab: 2 },
      }),
    );
    expect(result.edges["ab"]!.transferredPerSecond).toBeCloseTo(2, 9);
    expect(result.edges["as"]!.transferredPerSecond).toBeCloseTo(3, 9);
    expect(result.storages["sink"]!.producedPerSecond).toBeCloseTo(3, 9);
  });
});

describe("buffers", () => {
  const p = project({
    recipes: [recipe("a", [], [["y", 4]]), recipe("b", [["y", 1]], [])],
    nodes: [node("a", "a", { solvePin: 1 }), node("b", "b")],
    storages: [drawer("buf", "y")],
    edges: [
      wire("in", "a", "buf", "y", {}, { toDrawer: true }),
      wire("out", "buf", "b", "y", {}, { fromDrawer: true }),
    ],
  });

  it("a drawer fed and drawn from is a buffer drawer; each wire shows what passes at its port", () => {
    const { input, result } = run(p, () =>
      solved({
        extentsPerSecond: { a: 1, b: 4 },
        machineCounts: { a: 1, b: 4 },
        edgeFlowsPerSecond: {},
        drawers: {
          rates: { buf: 4 },
          unmet: [],
          shortfalls: [],
          ports: {
            buf: [
              { port: { node: "a", port: 0, input: false }, ratePerSecond: 4 },
              { port: { node: "b", port: 0, input: true }, ratePerSecond: 4 },
            ],
          },
        },
      }),
    );
    expect(input.edges).toHaveLength(0);
    expect(input.drawers).toEqual([
      {
        id: "buf",
        label: "y",
        kind: "BUFFER",
        rule: "ANY",
        rate: 0,
        links: [{ node: "a", port: 0 }],
        takers: [{ node: "b", port: 0 }],
      },
    ]);
    expect(result.edges["in"]!.transferredPerSecond).toBeCloseTo(4, 9);
    expect(result.edges["out"]!.transferredPerSecond).toBeCloseTo(4, 9);
    expect(result.storages["buf"]!.producedPerSecond).toBeCloseTo(4, 9);
  });

  it("a buffer's rule is a product's: at least, exactly or at most what passes through", () => {
    const ruled = { ...p, storages: [{ ...p.storages![0]!, targetPerSecond: 3, targetMode: "at-most" as const }] };
    const { input } = run(ruled);
    expect(input.drawers.map((d) => [d.kind, d.rule, d.rate])).toEqual([["BUFFER", "AT_MOST", 3]]);
  });

  it("a buffer wired to another drawer is still joined away", () => {
    const chained = project({
      recipes: [recipe("a", [], [["y", 4]]), recipe("b", [["y", 1]], [])],
      nodes: [node("a", "a", { solvePin: 1 }), node("b", "b")],
      storages: [drawer("b1", "y"), drawer("b2", "y")],
      edges: [
        wire("x", "a", "b1", "y", {}, { toDrawer: true }),
        wire("y", "b1", "b2", "y", {}, { fromDrawer: true, toDrawer: true }),
        wire("z", "b2", "b", "y", {}, { fromDrawer: true }),
      ],
    });
    const { input } = run(chained);
    expect(input.edges).toHaveLength(1);
    expect(input.drawers).toEqual([]);
  });
});

describe("oredict inputs", () => {
  it("a concrete item wired to an ore dictionary row finds the row", () => {
    const smelt = recipe("smelt", [["oredict:plank", 1]], [["out", 1]]);
    smelt.inputs[0]!.alternatives = [{ kind: "item", id: "birch-plank", amount: 1 }] as never;
    const saw = recipe("saw", [], [["birch-plank", 2]]);
    const edge = {
      ...wire("e", "w", "s", "birch-plank"),
      targetHandle: handle("input", "oredict:plank"),
    };
    const { input } = run(
      project({
        recipes: [smelt, saw],
        nodes: [node("s", "smelt"), node("w", "saw")],
        edges: [edge],
      }),
    );
    expect(input.edges).toHaveLength(1);
    const s = input.machines.find((m) => m.id === "s")!;
    const w = input.machines.find((m) => m.id === "w")!;
    expect(s.inputs[0]!.resource).toBe(w.outputs[0]!.resource);
  });
});

describe("unanchored", () => {
  it("names recipes and drawers in a part nothing sets", () => {
    const p = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]])],
      nodes: [node("pinned", "a", { solvePin: 1 }), node("loose", "a")],
      storages: [drawer("in1", "x"), drawer("out1", "y"), drawer("in2", "x"), drawer("out2", "y")],
      edges: [
        wire("i1", "in1", "pinned", "x", {}, { fromDrawer: true }),
        wire("o1", "pinned", "out1", "y", {}, { toDrawer: true }),
        wire("i2", "in2", "loose", "x", {}, { fromDrawer: true }),
        wire("o2", "loose", "out2", "y", {}, { toDrawer: true }),
      ],
    });
    const { result } = run(p);
    expect([...result.plan!.unanchored].sort()).toEqual(["in2", "loose", "out2"]);
  });

  it("a drawer asking for a number, or a port rate, sets its part", () => {
    const p = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]])],
      nodes: [node("n", "a"), node("m", "a", { portRates: { "output:item:y": 2 } })],
      storages: [
        drawer("in1", "x"),
        drawer("out1", "y", { targetPerSecond: 3, targetMode: "at-least" }),
        drawer("in2", "x"),
        drawer("out2", "y"),
      ],
      edges: [
        wire("i1", "in1", "n", "x", {}, { fromDrawer: true }),
        wire("o1", "n", "out1", "y", {}, { toDrawer: true }),
        wire("i2", "in2", "m", "x", {}, { fromDrawer: true }),
        wire("o2", "m", "out2", "y", {}, { toDrawer: true }),
      ],
    });
    expect(run(p).result.plan!.unanchored).toEqual([]);
  });

  it("a rate that only caps (at most) does not set a part", () => {
    const p = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]])],
      nodes: [node("n", "a")],
      storages: [
        drawer("in1", "x", { targetPerSecond: 3, targetMode: "at-most" }),
        drawer("out1", "y"),
      ],
      edges: [
        wire("i1", "in1", "n", "x", {}, { fromDrawer: true }),
        wire("o1", "n", "out1", "y", {}, { toDrawer: true }),
      ],
    });
    expect([...run(p).result.plan!.unanchored].sort()).toEqual(["in1", "n", "out1"]);
  });

  it("a buffer in a part nothing sets asks for a number with the rest", () => {
    const p = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1]]), recipe("b", [["y", 1]], [["z", 1]])],
      nodes: [node("n", "a"), node("m", "b")],
      storages: [drawer("buf", "y")],
      edges: [
        wire("in", "n", "buf", "y", {}, { toDrawer: true }),
        wire("out", "buf", "m", "y", {}, { fromDrawer: true }),
      ],
    });
    expect([...run(p).result.plan!.unanchored].sort()).toEqual(["buf", "m", "n"]);
  });
});

describe("terminals", () => {
  it("an unwired port with a drawer on it is not a free terminal", () => {
    const p = project({
      recipes: [recipe("a", [["x", 1]], [["y", 1], ["w", 1]])],
      nodes: [node("n", "a", { solvePin: 1 })],
      storages: [drawer("in", "x")],
      edges: [wire("i", "in", "n", "x", {}, { fromDrawer: true })],
    });
    const { result } = run(p, () =>
      solved({
        extentsPerSecond: { n: 1 },
        machineCounts: { n: 1 },
        terminalInputs: [{ port: { node: "n", port: 0, input: true }, ratePerSecond: 1 }],
        terminalOutputs: [
          { port: { node: "n", port: 0, input: false }, ratePerSecond: 1 },
          { port: { node: "n", port: 1, input: false }, ratePerSecond: 1 },
        ],
      }),
    );
    expect(result.plan!.terminals.map((t) => t.portKey)).toEqual([
      "n|o|output:item:y",
      "n|o|output:item:w",
    ]);
  });
});
