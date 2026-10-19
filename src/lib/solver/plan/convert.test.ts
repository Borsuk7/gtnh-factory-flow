import { describe, expect, it } from "vitest";
import { factoryProjectSchema } from "@/lib/model/schemas";
import {
  PROJECT_SCHEMA_VERSION,
  type FactoryEdge,
  type FactoryNode,
  type FactoryProject,
  type FactoryStorage,
  type Recipe,
} from "@/lib/model/types";
import { convertBuildToPlan, convertBuildToPlanWithReport } from "./convert";

function recipe(id: string, inputs: [string, number][], outputs: [string, number][]): Recipe {
  return {
    id,
    name: id,
    machineType: "Lab Machine",
    minimumTier: "LV",
    durationTicks: 20,
    eut: 30,
    inputs: inputs.map(([itemId, amount]) => ({ kind: "item" as const, id: itemId, amount })),
    outputs: outputs.map(([itemId, amount]) => ({ kind: "item" as const, id: itemId, amount })),
  };
}

function node(id: string, recipeId: string, machineCount = 1, extra?: Partial<FactoryNode>): FactoryNode {
  return {
    id,
    recipeId,
    machineCount,
    parallel: 1,
    overclockTier: "LV",
    enabled: true,
    position: { x: 0, y: 0 },
    ...extra,
  } as FactoryNode;
}

function drawer(id: string, resourceId: string, extra?: Partial<FactoryStorage>): FactoryStorage {
  return { id, kind: "item", resourceId, position: { x: 0, y: 0 }, ...extra };
}

function wire(id: string, source: string, target: string, resourceId: string, extra?: Partial<FactoryEdge>): FactoryEdge {
  return { id, source, target, resourceKind: "item", resourceId, ...extra };
}

function project(over: Partial<FactoryProject>): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "convert",
    name: "convert",
    recipes: [],
    nodes: [],
    edges: [],
    fuelProfiles: [],
    ...over,
  } as FactoryProject;
}

const chain = (over: Partial<FactoryProject> = {}) =>
  project({
    recipes: [recipe("make", [["ore", 1]], [["gear", 1]]), recipe("use", [["gear", 1]], [["kit", 1]])],
    nodes: [node("a", "make", 4), node("b", "use", 2)],
    storages: [drawer("src", "ore"), drawer("out", "kit")],
    edges: [wire("e1", "src", "a", "ore"), wire("e2", "a", "b", "gear"), wire("e3", "b", "out", "kit")],
    ...over,
  });

describe("convertBuildToPlan", () => {
  it("makes every enabled card's built count its pin, sets the flags and leaves the input alone", () => {
    const input = chain({ nodes: [node("a", "make", 4), node("b", "use", 2), node("c", "use", 3, { enabled: false })] });
    const before = JSON.stringify(input);
    const { project: plan, report } = convertBuildToPlanWithReport(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(plan.planMode).toBe(true);
    expect(plan.solveMode).toBe(true);
    expect(plan.poolMode).toBeUndefined();
    expect(plan.nodes.map((n) => n.solvePin)).toEqual([4, 2, undefined]);
    expect(report.pinned).toBe(2);
    expect(plan.edges).toEqual(input.edges);
  });

  it("returns a project already in plan mode as the same object", () => {
    const planned = chain({ planMode: true, solveMode: true });
    expect(convertBuildToPlan(planned)).toBe(planned);
  });

  it("leaves a classic Solve plan's pins and live drawer rates alone", () => {
    const solve = chain({
      solveMode: true,
      nodes: [node("a", "make", 4), node("b", "use", 2, { solvePin: 1.5 })],
      storages: [drawer("src", "ore"), drawer("out", "kit", { targetPerSecond: 3 })],
    });
    const plan = convertBuildToPlan(solve);
    expect(plan.nodes.map((n) => n.solvePin)).toEqual([undefined, 1.5]);
    expect(plan.storages![1]!.targetMode).toBeUndefined();
    expect(plan.planMode).toBe(true);
  });

  it("parks a Build drawer's rate as Ignore, keeping the number", () => {
    const plan = convertBuildToPlan(
      chain({
        storages: [
          drawer("src", "ore", { targetPerSecond: -5 }),
          drawer("out", "kit", { targetPerSecond: 3 }),
        ],
      }),
    );
    expect(plan.storages!.map((s) => [s.targetMode, s.targetPerSecond])).toEqual([
      ["ignore", -5],
      ["ignore", 3],
    ]);
  });

  it("drops pool mode", () => {
    const plan = convertBuildToPlan(chain({ solveMode: true, poolMode: true }));
    expect(plan.poolMode).toBeUndefined();
    expect(plan.solveMode).toBe(true);
  });

  it("pins a custom rate card at its dial in Solve, and at its count in Build", () => {
    const custom: Recipe = { ...recipe("custom-rate", [], [["water", 4]]), machineType: "Custom Rate" };
    const base = {
      recipes: [custom],
      nodes: [node("r", "custom-rate", 1)],
      storages: [drawer("out", "water")],
      edges: [wire("e", "r", "out", "water")],
    };
    expect(convertBuildToPlan(project({ ...base, solveMode: true })).nodes[0]!.solvePin).toBe(1);
    expect(convertBuildToPlan(project({ ...base, nodes: [node("r", "custom-rate", 3)] })).nodes[0]!.solvePin).toBe(3);
    expect(
      convertBuildToPlan(project({ ...base, solveMode: true, nodes: [node("r", "custom-rate", 3, { solvePin: 2 })] })).nodes[0]!
        .solvePin,
    ).toBe(2);
  });

  it("never pins a fluid tank card in Build: it has no count", () => {
    const tank: Recipe = {
      ...recipe("tank", [["fuel_cell", 1]], [["empty_cell", 1]]),
      machineType: "Tank",
      durationTicks: 1,
      source: { recipeMap: "Tank" },
    };
    const plan = convertBuildToPlan(
      project({
        recipes: [tank, recipe("use", [["empty_cell", 1]], [["kit", 1]])],
        nodes: [node("t", "tank", 1), node("b", "use", 2)],
        edges: [wire("e", "t", "b", "empty_cell")],
      }),
    );
    expect(plan.nodes.map((n) => n.solvePin)).toEqual([undefined, 2]);
  });

  describe("an unanchored Solve plan's targets become port rates", () => {
    it("leaves a Build plan's targets as they were: display only, no pin", () => {
      const { project: plan, report } = convertBuildToPlanWithReport(
        chain({
          targetRate: { kind: "item", resourceId: "gear", amountPerSecond: 2.5 },
          nodes: [
            node("a", "make", 4),
            node("b", "use", 2, { targetOutput: { kind: "item", resourceId: "kit", amountPerSecond: 7 } }),
          ],
        }),
      );
      expect(plan.nodes.map((n) => n.portRates)).toEqual([undefined, undefined]);
      expect(plan.nodes.map((n) => n.solvePin)).toEqual([4, 2]);
      expect(report.portRates).toBe(0);
    });

    it("puts a card's targetOutput on its output row", () => {
      const plan = convertBuildToPlan(
        chain({ solveMode: true,
          nodes: [
            node("a", "make", 4),
            node("b", "use", 2, { targetOutput: { kind: "item", resourceId: "kit", amountPerSecond: 7 } }),
          ],
        }),
      );
      expect(plan.nodes[1]!.portRates).toEqual({ "output:item:kit": 7 });
      // The classic field stays.
      expect(plan.nodes[1]!.targetOutput?.amountPerSecond).toBe(7);
    });

    it("reports a target the card does not make", () => {
      const { project: plan, report } = convertBuildToPlanWithReport(
        chain({ solveMode: true,
          nodes: [
            node("a", "make", 4, { targetOutput: { kind: "item", resourceId: "nothing", amountPerSecond: 7 } }),
            node("b", "use", 2),
          ],
        }),
      );
      expect(plan.nodes[0]!.portRates).toBeUndefined();
      expect(report.droppedTargets).toEqual(["a"]);
    });

    it("lands the plan's target on the first card making it", () => {
      const plan = convertBuildToPlan(
        chain({ solveMode: true, targetRate: { kind: "item", resourceId: "gear", amountPerSecond: 2.5 } }),
      );
      expect(plan.nodes[0]!.portRates).toEqual({ "output:item:gear": 2.5 });
      expect(plan.nodes[1]!.portRates).toBeUndefined();
    });

    it("lets a card that targets the resource keep it, and puts nothing else", () => {
      const plan = convertBuildToPlan(
        chain({ solveMode: true,
          targetRate: { kind: "item", resourceId: "kit", amountPerSecond: 99 },
          nodes: [
            node("a", "make", 4),
            node("b", "use", 2, { targetOutput: { kind: "item", resourceId: "kit", amountPerSecond: 7 } }),
          ],
        }),
      );
      expect(plan.nodes[1]!.portRates).toEqual({ "output:item:kit": 7 });
      expect(plan.nodes[0]!.portRates).toBeUndefined();
    });

    it("finds the maker in a shared machine's later section by its r<n>: handle", () => {
      const plan = convertBuildToPlan(
        project({
          solveMode: true,
          recipes: [recipe("one", [["a", 1]], [["x", 1]]), recipe("two", [["b", 1]], [["y", 1]])],
          nodes: [node("s", "one", 1, { extraRecipes: [{ recipeId: "two" }] })],
          targetRate: { kind: "item", resourceId: "y", amountPerSecond: 4 },
        }),
      );
      expect(plan.nodes[0]!.portRates).toEqual({ "r1:output:item:y": 4 });
    });

    it("encodes the resource id in the handle", () => {
      const plan = convertBuildToPlan(
        project({
          solveMode: true,
          recipes: [recipe("m", [], [["gt:foo bar", 1]])],
          nodes: [node("a", "m")],
          targetRate: { kind: "item", resourceId: "gt:foo bar", amountPerSecond: 1 },
        }),
      );
      expect(Object.keys(plan.nodes[0]!.portRates!)).toEqual(["output:item:gt%3Afoo%20bar"]);
    });
  });

  describe("buffer drawers", () => {
    const withBuffer = (extra?: Partial<FactoryStorage>, edgeExtra?: Partial<FactoryEdge>) =>
      project({
        recipes: [recipe("make", [], [["gear", 1]]), recipe("use", [["gear", 1]], [["kit", 1]]), recipe("use2", [["gear", 2]], [["bit", 1]])],
        nodes: [node("a", "make"), node("b", "use"), node("c", "use2")],
        storages: [drawer("buf", "gear", extra)],
        edges: [
          wire("in", "a", "buf", "gear"),
          wire("out1", "buf", "b", "gear", edgeExtra),
          wire("out2", "buf", "c", "gear", edgeExtra),
        ],
      });

    it("keeps a buffer wired only to cards as a buffer drawer", () => {
      const { project: plan, report } = convertBuildToPlanWithReport(withBuffer());
      expect(plan.storages!.map((s) => s.id)).toEqual(["buf"]);
      expect(plan.edges.map((e) => [e.id, e.source, e.target])).toEqual([
        ["in", "a", "buf"],
        ["out1", "buf", "b"],
        ["out2", "buf", "c"],
      ]);
      expect(report.buffersExpanded).toBe(0);
    });

    it("keeps a ratio buffer as a plain buffer, its shares dropped", () => {
      const { project: plan, report } = convertBuildToPlanWithReport(
        withBuffer({ bufferMode: "ratio", ratioExportPercent: 50 }, { ratioWeight: 3 }),
      );
      expect(plan.storages![0]!.bufferMode).toBeUndefined();
      expect(plan.storages![0]!.ratioExportPercent).toBeUndefined();
      expect(plan.edges).toHaveLength(3);
      expect(plan.edges.every((e) => e.ratioWeight === undefined && e.ratioInputWeight === undefined)).toBe(true);
      expect(report.ratioBuffersFlattened).toBe(1);
    });

    it("a buffer's rule survives the public schema (plan JSON, links, library posts)", () => {
      const ruled = withBuffer({ targetPerSecond: 12, targetMode: "exact" });
      const parsed = factoryProjectSchema.parse(JSON.parse(JSON.stringify({ ...ruled, planMode: true })));
      expect(parsed.storages![0]).toMatchObject({ id: "buf", targetPerSecond: 12, targetMode: "exact" });
      expect(parsed.edges.map((e) => [e.source, e.target])).toEqual([
        ["a", "buf"],
        ["buf", "b"],
        ["buf", "c"],
      ]);
    });

    it("parks a rate no older board enforced on a buffer", () => {
      const { project: plan } = convertBuildToPlanWithReport(withBuffer({ targetPerSecond: 5, targetMode: "exact" }));
      expect(plan.storages![0]!.targetMode).toBe("ignore");
      expect(plan.storages![0]!.targetPerSecond).toBe(5);
    });

    it("joins the ends of a chain of buffers", () => {
      const plan = convertBuildToPlan(
        project({
          recipes: [recipe("make", [], [["gear", 1]]), recipe("use", [["gear", 1]], [["kit", 1]])],
          nodes: [node("a", "make"), node("b", "use")],
          storages: [drawer("b1", "gear"), drawer("b2", "gear")],
          edges: [wire("x", "a", "b1", "gear"), wire("y", "b1", "b2", "gear"), wire("z", "b2", "b", "gear")],
        }),
      );
      expect(plan.storages).toEqual([]);
      expect(plan.edges.map((e) => [e.source, e.target])).toEqual([["a", "b"]]);
    });

    it("turns a source feeding a buffer into a source on each taker", () => {
      const plan = convertBuildToPlan(
        project({
          recipes: [recipe("use", [["gear", 1]], [["kit", 1]])],
          nodes: [node("b", "use"), node("c", "use")],
          storages: [drawer("src", "gear"), drawer("buf", "gear")],
          edges: [wire("i", "src", "buf", "gear"), wire("o1", "buf", "b", "gear"), wire("o2", "buf", "c", "gear")],
        }),
      );
      expect(plan.storages!.map((s) => s.id)).toEqual(["src"]);
      expect(plan.edges.map((e) => [e.source, e.target])).toEqual([
        ["src", "b"],
        ["src", "c"],
      ]);
    });

    it("leaves source, product and trash drawers alone", () => {
      const plan = convertBuildToPlan(chain({ storages: [drawer("src", "ore"), drawer("out", "kit", { drainMode: "trash" })] }));
      expect(plan.storages!.map((s) => s.id)).toEqual(["src", "out"]);
      expect(plan.edges).toHaveLength(3);
    });
  });

  it("produces a project the public schema accepts and keeps", () => {
    const plan = convertBuildToPlan(
      chain({
        targetRate: { kind: "item", resourceId: "kit", amountPerSecond: 2 },
        edges: chain().edges,
      }),
    );
    const parsed = factoryProjectSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(parsed.planMode).toBe(true);
    expect(parsed.targetRate).toEqual({ kind: "item", resourceId: "kit", amountPerSecond: 2 });
    expect(parsed.nodes[0]!.solvePin).toBe(4);
  });
});
