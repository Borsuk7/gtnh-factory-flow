import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadBiodieselDemoProject } from "@/examples";
import { computeCommunityPlanStats } from "@/lib/community/plan-stats";
import { parseFactoryProjectJson, serializeFactoryProject } from "@/lib/import-export/factory-json";
import { normalizeLoadedProject, normalizeLoadedProjectWithNotice } from "@/lib/model/project-normalize";
import { factoryProjectSchema } from "@/lib/model/schemas";
import { getStorageRoles, poolSideOf } from "@/lib/model/storage-role";
import {
  PROJECT_SCHEMA_VERSION,
  type FactoryEdge,
  type FactoryProject,
  type ThroughputResult,
} from "@/lib/model/types";
import { initLpEngine } from "../lp-engine";
import { calculateThroughput } from "../throughput";
import { customRecipe, drawer, node, recipe, wire } from "./adapter/test-kit";
import { openAsPlan, toPlanProject } from "./to-plan";
import { wirePoolProject } from "./pool-to-plan";
import { planClipboard } from "./convert";
import { useFactoryStore } from "@/store/factory-store";
import { listNodeSections } from "@/lib/model/shared-machine";

beforeAll(async () => {
  await initLpEngine();
});

/* ------------------------------------------------------------------ */
/* The example plans: every shipped plan, as a Build, a Solve and a Pool plan. */

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const EXAMPLES: Array<{ name: string; load: () => FactoryProject }> = [
  { name: "biodiesel-demo (src/examples)", load: () => loadBiodieselDemoProject() },
  { name: "biodiesel-demo (examples/*.json)", load: () => read("../../../../examples/biodiesel-demo.json") },
  { name: "alumina-line-shared-reactor", load: () => read("../../../components/flow/__fixtures__/alumina-line-shared-reactor.json") },
  { name: "titanium-line-chembath", load: () => read("../../../components/flow/__fixtures__/titanium-line-chembath.json") },
  { name: "titanium-line-chembath.slim", load: () => read("../../../components/flow/__fixtures__/titanium-line-chembath.json.slim.json") },
  { name: "pa-cell-loop-plan", load: () => read("../__fixtures__/pa-cell-loop-plan.json") },
  { name: "pa-cell-loop-plan-3x", load: () => read("../__fixtures__/pa-cell-loop-plan-3x.json") },
  { name: "pa-cell-loop-plan-1x-strict", load: () => read("../__fixtures__/pa-cell-loop-plan-1x-strict.json") },
  { name: "pa-cell-loop-plan-3x-strict", load: () => read("../__fixtures__/pa-cell-loop-plan-3x-strict.json") },
  { name: "high-amperage-reactor", load: () => read("../__fixtures__/high-amperage-reactor.json") },
];

/** The old modes' own load, so the fixtures stay Build plans. */
const build = (load: () => FactoryProject) =>
  normalizeLoadedProject(factoryProjectSchema.parse(load()), { keepMode: true });

/**
 * The same plan as a Solve plan: no pins, and each product drawer asks for
 * what the Build books made. A plan that makes nothing into a drawer keeps
 * its pins on the cards nothing is wired out of.
 */
function asSolve(raw: FactoryProject): FactoryProject {
  const books = calculateThroughput(raw, { generatedAt: "t" });
  const roles = getStorageRoles(raw);
  let asked = 0;
  const storages = (raw.storages ?? []).map((storage) => {
    if (roles.get(storage.id) !== "product") return storage;
    const made = raw.edges
      .filter((edge) => edge.target === storage.id)
      .reduce((sum, edge) => sum + (books.edges[edge.id]?.transferredPerSecond ?? 0), 0);
    if (!(made > 0)) return storage;
    asked += 1;
    return { ...storage, targetPerSecond: made, targetMode: "at-least" as const };
  });
  const feeds = new Set(raw.edges.map((edge) => edge.source));
  return {
    ...raw,
    solveMode: true,
    storages,
    nodes: raw.nodes.map((entry) => ({
      ...entry,
      targetOutput: undefined,
      solvePin: asked === 0 && !feeds.has(entry.id) ? entry.machineCount : undefined,
    })),
  };
}

/** The Solve plan as a Pool plan: no wires, each drawer on its side of the pool. */
function asPool(solve: FactoryProject): FactoryProject {
  const roles = getStorageRoles(solve);
  const wiredIn = new Set(solve.edges.map((edge) => edge.target));
  const wiredOut = new Set(solve.edges.map((edge) => edge.source));
  return {
    ...solve,
    poolMode: true,
    edges: [],
    storages: (solve.storages ?? []).map((storage) => ({
      ...storage,
      poolSide:
        roles.get(storage.id) === "buffer"
          ? undefined
          : poolSideOf(storage, wiredIn.has(storage.id), wiredOut.has(storage.id)),
    })),
  };
}

/** A card's answer: its sections' counts together (a shared machine is one card). */
const cardCount = (result: ThroughputResult, entry: FactoryProject["nodes"][number]) =>
  listNodeSections(entry).reduce((sum, part) => sum + result.nodes[part.node.id]!.theoreticalMachinesRequired, 0);

const counts = (result: ThroughputResult, project: FactoryProject) =>
  project.nodes.filter((entry) => entry.enabled).map((entry) => cardCount(result, entry));

/**
 * Plans whose old Solve answer is all zero: they have a bare port, which the old
 * Solve read as "this machine must stop" (spec-adapter 2.8.1). The plan board
 * leaves a bare port free, so it runs them.
 */
const OLD_SOLVE_ANSWERS_ZERO = new Set([
  "biodiesel-demo (src/examples)",
  "biodiesel-demo (examples/*.json)",
  "titanium-line-chembath",
  "titanium-line-chembath.slim",
]);

/** Pool plans that ask a drain for a resource the pool also imports (see the pool test below). */
const POOL_FED_DRAIN_BY_IMPORT = new Set(["alumina-line-shared-reactor"]);

describe.each(EXAMPLES)("example $name", ({ name, load }) => {
  const raw = () => build(load);

  it("a Build plan opens as a plan, untouched in storage, and converts only once", () => {
    const stored = raw();
    const before = JSON.stringify(stored);
    const opened = openAsPlan(stored);
    expect(JSON.stringify(stored)).toBe(before);
    expect(opened.origin).toBe("build");
    expect(opened.project.planMode).toBe(true);
    expect(opened.project.solveMode).toBe(true);
    expect(opened.project.poolMode).toBeUndefined();
    expect(openAsPlan(opened.project).project).toBe(opened.project);
    expect(openAsPlan(opened.project).origin).toBeUndefined();
  });

  it("a Build plan opens, solves, and every card runs up to its built count, never below what Build ran it at", () => {
    // Its counts become Up to pins (docs/up-to.md): a card runs as hard as the plan lets it, as in Build, not at its
    // count whatever it takes. A bare port Build read as a stop is a free end here, so a card may run more than in Build.
    const stored = raw();
    const books = calculateThroughput(stored, { generatedAt: "t" });
    const plan = toPlanProject(stored);
    const result = calculateThroughput(plan, { generatedAt: "t" });
    expect(result.plan).toBeDefined();
    expect(result.plan?.failure).toBeUndefined();
    expect(Object.keys(result.bottlenecks ?? {}).filter((key) => key.startsWith("solve-"))).toEqual([]);
    for (const entry of stored.nodes.filter((candidate) => candidate.enabled)) {
      const solved = cardCount(result, entry);
      expect(Number.isFinite(solved)).toBe(true);
      expect(solved, entry.id).toBeLessThanOrEqual(entry.machineCount + 1e-6);
      const built = entry.machineCount * Math.min(1, Math.max(0, books.nodes[entry.id]?.utilization ?? 0));
      expect(solved, entry.id).toBeGreaterThanOrEqual(built - 1e-6 * Math.max(1, entry.machineCount));
    }
  });

  it("a Build plan survives export and import as a plan (planMode and solveMode both written)", () => {
    const plan = toPlanProject(raw());
    const text = serializeFactoryProject(plan);
    const json = JSON.parse(text);
    expect(json.planMode).toBe(true);
    expect(json.solveMode).toBe(true);
    const again = parseFactoryProjectJson(text);
    expect(again.planMode).toBe(true);
    expect(again.nodes.map((entry) => entry.solvePin)).toEqual(plan.nodes.map((entry) => entry.solvePin));
    expect(again.edges.length).toBe(plan.edges.length);
  });

  it("a Solve plan runs with the old Solve's counts (or the plan board's where old Solve answers zero)", () => {
    const solve = asSolve(raw());
    const old = calculateThroughput(solve, { generatedAt: "t" });
    const opened = openAsPlan(solve);
    expect(opened.origin).toBe("solve");
    const result = calculateThroughput(opened.project, { generatedAt: "t" });
    expect(result.plan).toBeDefined();
    const planCounts = counts(result, solve);
    expect(planCounts.every(Number.isFinite)).toBe(true);
    if (OLD_SOLVE_ANSWERS_ZERO.has(name)) {
      expect(counts(old, solve).every((value) => value === 0)).toBe(true);
      expect(planCounts.some((value) => value > 0)).toBe(true);
    } else {
      const oldCounts = counts(old, solve);
      planCounts.forEach((value, index) => expect(value).toBeCloseTo(oldCounts[index]!, 4));
    }
  });

  it("a Pool plan is wired per resource and runs with the old Pool's counts", () => {
    const pool = asPool(asSolve(raw()));
    const old = calculateThroughput(pool, { generatedAt: "t" });
    const opened = openAsPlan(pool);
    expect(opened.origin).toBe("pool");
    expect(opened.notice?.text).toMatch(/pool plan/i);
    expect(opened.project.poolMode).toBeUndefined();
    expect(opened.project.planMode).toBe(true);
    expect(opened.project.edges.length).toBeGreaterThan(0);
    // one wire per resource per pair
    const seen = new Set<string>();
    for (const edge of opened.project.edges) {
      const key = `${edge.source}.${edge.sourceHandle}>${edge.target}.${edge.targetHandle}:${edge.resourceKind}:${edge.resourceId}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    const result = calculateThroughput(opened.project, { generatedAt: "t" });
    expect(result.plan).toBeDefined();
    const planCounts = counts(result, pool);
    if (OLD_SOLVE_ANSWERS_ZERO.has(name)) {
      expect(planCounts.some((value) => value > 0)).toBe(true);
    } else if (POOL_FED_DRAIN_BY_IMPORT.has(name)) {
      // The pool let a source drawer feed a drain of the same resource
      // straight (an import that is exported again). Drawers do not wire to
      // drawers on the plan board, so that drain is fed by the makers only.
      expect(planCounts.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(planCounts.some((value) => value > 0)).toBe(true);
    } else {
      const oldCounts = counts(old, pool);
      planCounts.forEach((value) => expect(Number.isFinite(value)).toBe(true));
      planCounts.forEach((value, index) => expect(value).toBeCloseTo(oldCounts[index]!, 4));
    }
  });
});

/* ------------------------------------------------------------------ */
/* Pool wiring on small plans. */

function poolPlan(over: Partial<FactoryProject> = {}): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "pool",
    name: "pool",
    solveMode: true,
    poolMode: true,
    recipes: [recipe("rA", [["ore", 2]], [["dust", 1]]), recipe("rB", [["dust", 1]], [["plate", 1]])],
    nodes: [node("a", "rA"), node("b", "rB")],
    storages: [
      drawer("ore", "ore", { poolSide: "source" }),
      drawer("plate", "plate", { poolSide: "drain", targetPerSecond: 3, targetMode: "at-least" }),
    ],
    edges: [],
    fuelProfiles: [],
    ...over,
  } as FactoryProject;
}

describe("pool plans", () => {
  it("wire each resource's makers to its users, drawers to their side, and nothing else", () => {
    const { project, report } = wirePoolProject(poolPlan());
    const pairs = project.edges.map((edge) => `${edge.source}>${edge.target}:${edge.resourceId}`).sort();
    expect(pairs).toEqual(["a>b:dust", "b>plate:plate", "ore>a:ore"]);
    expect(report.wires).toBe(3);
    expect(project.poolMode).toBeUndefined();
    expect(project.storages!.every((storage) => storage.poolSide === undefined)).toBe(true);
  });

  it("solves like the pool did: the plate drawer sets the line", () => {
    const opened = openAsPlan(poolPlan());
    const result = calculateThroughput(opened.project, { generatedAt: "t" });
    expect(result.nodes["b"]!.theoreticalMachinesRequired).toBeCloseTo(3, 6);
    expect(result.nodes["a"]!.theoreticalMachinesRequired).toBeCloseTo(3, 6);
  });

  it("drops saved wires (the pool ignored them), groups and rules, and says so", () => {
    const stale: FactoryEdge = wire("old", "a", "b", "dust");
    const opened = openAsPlan(
      poolPlan({
        edges: [stale],
        productionGroups: [{ id: "g", name: "g" }] as FactoryProject["productionGroups"],
        poolResourceRules: { "item:dust": "share" } as FactoryProject["poolResourceRules"],
        nodes: [node("a", "rA", { productionGroupId: "g" }), node("b", "rB")],
      }),
    );
    expect(opened.project.edges.find((edge) => edge.id === "old")).toBeUndefined();
    expect(opened.project.productionGroups).toBeUndefined();
    expect(opened.project.poolResourceRules).toBeUndefined();
    expect(opened.project.nodes[0]!.productionGroupId).toBeUndefined();
    expect(opened.pool).toMatchObject({ groups: 1, rules: 1, savedWiresDropped: 1 });
    expect(opened.notice?.details).toEqual(
      expect.arrayContaining(["Groups are gone.", "Share and Outside supply switches are gone."]),
    );
  });

  it("wires every maker to every user, once per pair", () => {
    const opened = openAsPlan(
      poolPlan({
        nodes: [node("a1", "rA"), node("a2", "rA"), node("b1", "rB"), node("b2", "rB")],
      }),
    );
    const dust = opened.project.edges.filter((edge) => edge.resourceId === "dust");
    expect(dust).toHaveLength(4);
    expect(new Set(dust.map((edge) => edge.id)).size).toBe(4);
  });

  it("leaves a card that feeds itself unwired to itself", () => {
    const loop = poolPlan({
      recipes: [recipe("r", [["x", 1]], [["x", 2]])],
      nodes: [node("a", "r")],
      storages: [],
    });
    expect(openAsPlan(loop).project.edges).toEqual([]);
  });

  it("joins drawers of one resource on one side into one, rates added", () => {
    const { project, report } = wirePoolProject(
      poolPlan({
        storages: [
          drawer("p1", "plate", { poolSide: "drain", targetPerSecond: 3, targetMode: "at-least" }),
          drawer("p2", "plate", { poolSide: "drain", targetPerSecond: 2, targetMode: "at-least" }),
          drawer("p3", "plate", { poolSide: "drain" }),
        ],
      }),
    );
    expect(report.duplicateDrawers).toEqual(["p2", "p3"]);
    expect(project.storages!.map((storage) => storage.id)).toEqual(["p1"]);
    expect(project.storages![0]).toMatchObject({ targetPerSecond: 5, targetMode: "at-least" });
  });

  it("bridges a cell and its fluid with a fluid tank", () => {
    const cellRecipe = recipe("mk", [["ore", 1]], [["Water Cell", 1]]);
    const fluidRecipe = {
      ...recipe("use", [], [["x", 1]]),
      inputs: [{ kind: "fluid" as const, id: "water", amount: 1000, displayName: "Water" }],
    };
    const bridged = poolPlan({
      recipes: [cellRecipe, fluidRecipe],
      nodes: [node("mk", "mk"), node("use", "use")],
      storages: [],
      poolCellRatios: { "Water Cell": 1000 },
    });
    const { project, report } = wirePoolProject(bridged);
    // The Water Cell holds Water, at the Canner litres the plan fetched: one tank between maker and user.
    expect(report.bridgeWires).toBe(1);
    expect(project.edges.some((edge) => edge.crossForm)).toBe(false);
    const tank = project.nodes.find((node) => node.id.startsWith("cell-tank:"));
    expect(tank).toBeDefined();
    expect(project.edges.filter((edge) => edge.source === tank!.id || edge.target === tank!.id).map((edge) => [edge.source, edge.target])).toEqual([
      ["mk", tank!.id],
      [tank!.id, "use"],
    ]);
  });
});

describe("Build and Solve plans: what changes and what does not", () => {
  const chain = (over: Partial<FactoryProject> = {}): FactoryProject =>
    ({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "chain",
      name: "chain",
      recipes: [recipe("rA", [["ore", 2]], [["dust", 1]]), recipe("rB", [["dust", 1]], [["plate", 1]])],
      nodes: [node("a", "rA", { machineCount: 4 }), node("b", "rB", { machineCount: 2 })],
      storages: [drawer("ore", "ore"), drawer("plate", "plate", { targetPerSecond: 5, targetMode: "exact" })],
      edges: [
        wire("e1", "ore", "a", "ore"),
        wire("e2", "a", "b", "dust"),
        wire("e3", "b", "plate", "plate"),
      ],
      fuelProfiles: [],
      ...over,
    }) as FactoryProject;

  it("a Build plan's drawer rates stay as numbers but stop being rules", () => {
    const opened = openAsPlan(chain());
    expect(opened.project.storages!.find((storage) => storage.id === "plate")!.targetMode).toBe("ignore");
    expect(opened.project.storages!.find((storage) => storage.id === "plate")!.targetPerSecond).toBe(5);
  });

  it("a Solve plan's rates stay live", () => {
    const opened = openAsPlan(chain({ solveMode: true }));
    expect(opened.origin).toBe("solve");
    expect(opened.project.storages!.find((storage) => storage.id === "plate")!.targetMode).toBe("exact");
    const result = calculateThroughput(opened.project, { generatedAt: "t" });
    expect(result.nodes["b"]!.theoreticalMachinesRequired).toBeCloseTo(5, 6);
  });

  it("a Solve plan's stale card target is not turned into a pin", () => {
    const opened = openAsPlan(
      chain({
        solveMode: true,
        nodes: [
          node("a", "rA"),
          node("b", "rB", { targetOutput: { kind: "item", resourceId: "plate", amountPerSecond: 99 } }),
        ],
      }),
    );
    expect(opened.project.nodes[1]!.portRates).toBeUndefined();
  });

  it("a converted Build or Solve plan always says what came over; an empty one says nothing", () => {
    const notice = openAsPlan(chain()).notice;
    expect(notice?.text).toBe("Converted from a Build plan.");
    expect(notice?.details).toContain("2 cards set to up to their counts.");
    expect(openAsPlan(chain({ solveMode: true })).notice?.text).toBe("Converted from a Solve plan.");
    expect(openAsPlan({ ...chain(), nodes: [], edges: [], storages: [] }).notice).toBeUndefined();
  });

  it("a Solve plan nothing sets takes its stated targets as port rates, and names what it dropped", () => {
    const opened = openAsPlan(
      chain({
        solveMode: true,
        storages: [],
        nodes: [
          node("a", "rA"),
          node("b", "rB", { targetOutput: { kind: "item", resourceId: "plate", amountPerSecond: 99 } }),
        ],
      }),
    );
    expect(Object.values(opened.project.nodes[1]!.portRates ?? {})).toEqual([99]);
    expect(opened.notice?.details).toContain("1 rate set from a target.");
    const bare = openAsPlan(chain({ solveMode: true, storages: [] }));
    expect(bare.notice?.details).toContain("Nothing is set yet. Pin a count or set a rate.");
  });

  it("a custom rate card is pinned at its dial", () => {
    const opened = openAsPlan(
      chain({
        recipes: [
          recipe("rA", [["ore", 2]], [["dust", 1]]),
          recipe("rB", [["dust", 1]], [["plate", 1]]),
          customRecipe("rate", "ore", 6, "supply"),
        ],
        nodes: [node("a", "rA", { machineCount: 4 }), node("b", "rB", { machineCount: 2 }), node("r", "rate")],
      }),
    );
    expect(opened.project.nodes.find((entry) => entry.id === "r")!.solvePin).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Every entry path goes through the one funnel. */

describe("the funnel", () => {
  it("normalizeLoadedProject converts, and its notice names a pool plan", () => {
    const { project, notice } = normalizeLoadedProjectWithNotice(poolPlan());
    expect(project.planMode).toBe(true);
    expect(notice?.origin).toBe("pool");
    expect(normalizeLoadedProject(project)).toBeDefined();
  });

  it("a plan already in plan mode comes through as it is", () => {
    const plan = toPlanProject(poolPlan());
    const again = normalizeLoadedProjectWithNotice(plan);
    expect(again.notice).toBeUndefined();
    expect(again.project.planMode).toBe(true);
    expect(again.project.edges.length).toBe(plan.edges.length);
  });

  it("JSON, plan links and imports parse as saved and become plans when they land on the board", () => {
    for (const mode of [{}, { solveMode: true }, { solveMode: true, poolMode: true }]) {
      const text = JSON.stringify({ ...poolPlan(), solveMode: undefined, poolMode: undefined, ...mode });
      const parsed = parseFactoryProjectJson(text);
      expect(parsed.planMode).toBeUndefined();
      useFactoryStore.getState().markHydratedProject(parsed);
      const landed = useFactoryStore.getState().project;
      expect(landed.planMode).toBe(true);
      expect(landed.solveMode).toBe(true);
      expect(landed.poolMode).toBeUndefined();
    }
  });

  it("a community post opens the same way (loadViewedProject)", () => {
    const parsed = parseFactoryProjectJson(JSON.stringify(poolPlan()));
    useFactoryStore.getState().loadViewedProject(parsed);
    expect(useFactoryStore.getState().project.planMode).toBe(true);
    expect(useFactoryStore.getState().planNotice?.origin).toBe("pool");
    useFactoryStore.setState({ isReadOnly: false });
  });

  it("a pasted clipboard from an older board keeps its buffer as a plain buffer, losing ratios, pool sides and groups", () => {
    const clipboard = {
      nodes: [node("a", "rA", { productionGroupId: "g" }), node("b", "rB")],
      storages: [
        drawer("buf", "dust", { bufferMode: "ratio", poolSide: "drain", productionGroupId: "g" }),
      ],
      edges: [
        { ...wire("e1", "a", "buf", "dust"), ratioWeight: 2 },
        { ...wire("e2", "buf", "b", "dust"), ratioWeight: 1 },
      ],
      productionGroups: [{ id: "g" }],
    };
    const pasted = planClipboard(clipboard as never) as typeof clipboard;
    expect(pasted.storages.map((s) => s.id)).toEqual(["buf"]);
    expect((pasted.storages[0] as { bufferMode?: string }).bufferMode).toBeUndefined();
    expect((pasted.storages[0] as { poolSide?: string }).poolSide).toBeUndefined();
    expect(pasted.edges).toHaveLength(2);
    expect(pasted.edges.every((e) => e.ratioWeight === undefined)).toBe(true);
    expect(pasted.nodes[0]!.productionGroupId).toBeUndefined();
    expect(pasted.productionGroups).toBeUndefined();
  });
});

describe("the notice", () => {
  it("survives the converted plan being hydrated again (a recipe refresh) until dismissed", () => {
    const store = useFactoryStore.getState();
    store.markHydratedProject(poolPlan());
    expect(useFactoryStore.getState().planNotice?.origin).toBe("pool");
    useFactoryStore.getState().markHydratedProject(useFactoryStore.getState().project);
    expect(useFactoryStore.getState().planNotice?.origin).toBe("pool");
    useFactoryStore.getState().dismissPlanNotice();
    expect(useFactoryStore.getState().planNotice).toBeNull();
  });
});

describe("server stats for an old plan", () => {
  it("count the solved machines, as the plan board runs it", () => {
    const stored = build(() => loadBiodieselDemoProject());
    const plan = normalizeLoadedProject(stored);
    const result = calculateThroughput(plan, { generatedAt: "t" });
    const stats = computeCommunityPlanStats(plan, result);
    expect(stats.machineCount).toBe(
      stored.nodes.filter((entry) => entry.enabled).reduce((sum, entry) => sum + Math.ceil(entry.machineCount - 1e-6), 0),
    );
    expect(stats.edgeCount).toBe(plan.edges.length);
  });
});
