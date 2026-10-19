import {
  PROJECT_SCHEMA_VERSION,
  type EdgeThroughput,
  type FactoryEdge,
  type FactoryNode,
  type FactoryProject,
  type FactoryStorage,
  type NodeThroughputResult,
  type Recipe,
  type ResourceBalance,
  type ResourceFlow,
  type ResourceKey,
  type StorageThroughputResult,
  type ThroughputResult,
} from "../../../model/types";
import { makeLeftoverKey, makePortKey } from "../port-key";
import type { PlanLeftover, PlanSolveExtras } from "../types";

/**
 * Five hand-built plan-mode results for the UI packages, shaped exactly as the
 * adapter will return them (`ThroughputResult` with `plan`), so cards, drawers
 * and the overview can be built before the solver is wired. The numbers are
 * consistent (every wire's flow balances at its ports, forced rows are the
 * gaps) but they are NOT solver output: do not use them as goldens.
 *
 * Every recipe runs one craft per second per machine (20 ticks), so a node's
 * solved count is its craft rate and amounts read as rates. Items only.
 *
 *   mockForced      pinned crusher and smelter; dust leaves at a port with no
 *                   drawer (forced output), coal comes in at another (forced
 *                   input); a product drawer is met exactly.
 *   mockLeftovers   a shortfall that two input places could bear (stored 25/75
 *                   split, `spareShares`) and a surplus with two possible
 *                   places (the solver's pick, no stored split).
 *   mockUnneeded    a machine nothing pinned feeds or needs at zero, a separate
 *                   island nothing sets (unanchored recipe and drawer), and a
 *                   drawer whose rate cannot be reached (note + unmet).
 *   mockLoops       a dead loop of three Up to cards and a clog lock of two
 *                   (`extras.loops`).
 *   mockUpTo        Up to cards in every reason (`extras.upTo`), an Exactly
 *                   card fed by a forced input, an Exactly card with nothing
 *                   forced and an Any card. The other mocks' pins are Exactly.
 */

export interface MockPlan {
  name: string;
  description: string;
  project: FactoryProject;
  result: ThroughputResult;
}

type Slot = [item: string, amount: number];

interface MockRecipe {
  id: string;
  inputs: Slot[];
  outputs: Slot[];
  /** A GregTech recipe dialled to this programmed circuit (the card's badge in the well). */
  circuit?: string;
  /** The machine the recipe runs in (`machineType`, the name notices use); "Mock Machine" by default. */
  machine?: string;
}

interface MockNode {
  id: string;
  recipe: string;
  /** The solved count (= crafts per second). */
  count: number;
  /** A pin (`solvePin`) the player set: Up to, unless `exact`. */
  pin?: number;
  /** The pin is Exactly (`solvePinExact`). */
  exact?: boolean;
  /** Reached over the pin for an Up to card (the engine's `utilization`); else 1 when running, 0 at zero. */
  utilization?: number;
  /** More recipes on the same machine (a shared machine): each a solve node `id#rN` with its own solved count. */
  sections?: Array<{ recipe: string; count: number }>;
  portRates?: Record<string, number>;
  x: number;
  y: number;
}

interface MockDrawer {
  id: string;
  item: string;
  kind: "source" | "product";
  rate?: number;
  mode?: "at-least" | "at-most" | "exact";
  x: number;
  y: number;
}

/** A wire and the rate it carries. */
interface MockWire {
  id: string;
  from: string;
  to: string;
  item: string;
  perSecond: number;
}

interface MockSpec {
  id: string;
  name: string;
  description: string;
  recipes: MockRecipe[];
  nodes: MockNode[];
  drawers: MockDrawer[];
  wires: MockWire[];
  spareShares?: FactoryProject["spareShares"];
  extras: PlanSolveExtras;
}

const key = (item: string): ResourceKey => `item:${item}` as ResourceKey;
const flow = (item: string, amountPerSecond: number): ResourceFlow => ({
  key: key(item),
  kind: "item",
  resourceId: item,
  displayName: item,
  amountPerSecond,
});

const handle = (side: "input" | "output", item: string) =>
  `${side}:item:${encodeURIComponent(item)}`;

function build(spec: MockSpec): MockPlan {
  const recipes: Recipe[] = spec.recipes.map((r) => ({
    id: r.id,
    name: r.id,
    machineType: r.machine ?? "Mock Machine",
    minimumTier: "LV",
    durationTicks: 20,
    eut: 30,
    inputs: [
      ...r.inputs.map(([id, amount]) => ({ kind: "item" as const, id, amount, displayName: id })),
      ...(r.circuit
        ? [
            {
              kind: "item" as const,
              id: `gregtech:gt.integrated_circuit@${r.circuit}`,
              amount: 0,
              consumed: false,
              displayName: "Programmed Circuit",
            },
          ]
        : []),
    ],
    outputs: r.outputs.map(([id, amount]) => ({ kind: "item", id, amount, displayName: id })),
    ...(r.circuit ? { kind: "gregtech_machine" as const, programmedCircuit: r.circuit } : {}),
  }));
  const recipeById = new Map(spec.recipes.map((r) => [r.id, r]));

  const nodes: FactoryNode[] = spec.nodes.map((n) => ({
    id: n.id,
    recipeId: n.recipe,
    machineCount: 1,
    parallel: 1,
    overclockTier: "LV",
    enabled: true,
    position: { x: n.x, y: n.y },
    ...(n.pin !== undefined ? { solvePin: n.pin } : {}),
    ...(n.exact ? { solvePinExact: true } : {}),
    ...(n.sections ? { extraRecipes: n.sections.map((s) => ({ recipeId: s.recipe })) } : {}),
    ...(n.portRates ? { portRates: n.portRates } : {}),
  }));
  // Every solve node: a card, and each further recipe of a shared machine as `id#rN`.
  const solveNodes = spec.nodes.flatMap((n) => [
    { id: n.id, recipe: n.recipe, count: n.count, utilization: n.utilization },
    ...(n.sections ?? []).map((s, i) => ({
      id: `${n.id}#r${i + 1}`,
      recipe: s.recipe,
      count: s.count,
      utilization: n.utilization,
    })),
  ]);
  const storages: FactoryStorage[] = spec.drawers.map((d) => ({
    id: d.id,
    kind: "item",
    resourceId: d.item,
    displayName: d.item,
    position: { x: d.x, y: d.y },
    ...(d.rate !== undefined ? { targetPerSecond: d.rate, targetMode: d.mode ?? "at-least" } : {}),
  }));
  const isDrawer = new Set(spec.drawers.map((d) => d.id));
  const edges: FactoryEdge[] = spec.wires.map((w) => ({
    id: w.id,
    source: w.from,
    target: w.to,
    sourceHandle: isDrawer.has(w.from) ? undefined : handle("output", w.item),
    targetHandle: isDrawer.has(w.to) ? undefined : handle("input", w.item),
    resourceKind: "item",
    resourceId: w.item,
  }));

  const project: FactoryProject = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    solveMode: true,
    planMode: true,
    recipes,
    nodes,
    storages,
    edges,
    ...(spec.spareShares ? { spareShares: spec.spareShares } : {}),
    fuelProfiles: [],
  } as FactoryProject;

  const nodeResults: Record<string, NodeThroughputResult> = {};
  let totalEuT = 0;
  for (const n of solveNodes) {
    const r = recipeById.get(n.recipe)!;
    const inputs: Record<ResourceKey, ResourceFlow> = {};
    const outputs: Record<ResourceKey, ResourceFlow> = {};
    // A machine at zero keeps its nameplate flows (one machine) so ports and
    // handles are still built from them.
    const scale = n.count > 0 ? n.count : 1;
    for (const [item, amount] of r.inputs) inputs[key(item)] = flow(item, amount * scale);
    for (const [item, amount] of r.outputs) outputs[key(item)] = flow(item, amount * scale);
    const euT = 30 * n.count;
    totalEuT += euT;
    nodeResults[n.id] = {
      nodeId: n.id,
      recipeId: n.recipe,
      recipeName: r.id,
      enabled: true,
      operationRatePerSecond: scale,
      inputs,
      outputs,
      euT,
      requiredRatePerSecond: 0,
      maxRatePerSecond: 0,
      utilization: n.utilization ?? (n.count > 0 ? 1 : 0),
      theoreticalMachinesRequired: n.count,
      status: n.count > 0 ? "balanced" : "underutilized",
      warnings: [],
    };
  }

  const edgeResults: Record<string, EdgeThroughput> = {};
  for (const w of spec.wires) {
    edgeResults[w.id] = {
      edgeId: w.id,
      resource: flow(w.item, w.perSecond),
      demandPerSecond: w.perSecond,
      transferredPerSecond: w.perSecond,
      isLimited: false,
      nameplateDemandPerSecond: w.perSecond,
      sourceCapacityPerSecond: w.perSecond,
      constraint: "full",
    };
  }

  const storageResults: Record<string, StorageThroughputResult> = {};
  for (const d of spec.drawers) {
    // As the real books (throughput.ts refreshStorageResultsFromEdges): what flows into a drawer is its produced, what
    // flows out of it its consumed.
    const produced = spec.wires.filter((w) => w.to === d.id).reduce((a, w) => a + w.perSecond, 0);
    const consumed = spec.wires.filter((w) => w.from === d.id).reduce((a, w) => a + w.perSecond, 0);
    storageResults[d.id] = {
      storageId: d.id,
      kind: "item",
      resourceId: d.item,
      displayName: d.item,
      storedAmount: 0,
      capacity: 0,
      producedPerSecond: produced,
      consumedPerSecond: consumed,
      netPerSecond: produced - consumed,
      status: "balanced",
      ...(d.rate !== undefined ? { targetPerSecond: d.rate } : {}),
      ...(d.rate !== undefined && d.kind === "product" && produced < d.rate - 1e-9
        ? { targetUnreachable: true }
        : {}),
    };
  }

  const resources: Record<ResourceKey, ResourceBalance> = {};
  const items = new Set<string>();
  for (const r of spec.recipes) {
    for (const [item] of [...r.inputs, ...r.outputs]) items.add(item);
  }
  for (const item of items) {
    let produced = 0;
    let consumed = 0;
    for (const n of solveNodes) {
      const r = recipeById.get(n.recipe)!;
      const scale = n.count;
      produced += (r.outputs.find(([i]) => i === item)?.[1] ?? 0) * scale;
      consumed += (r.inputs.find(([i]) => i === item)?.[1] ?? 0) * scale;
    }
    const imported = spec.drawers
      .filter((d) => d.kind === "source" && d.item === item)
      .reduce((a, d) => a + storageResults[d.id]!.consumedPerSecond, 0);
    const product = spec.drawers
      .filter((d) => d.kind === "product" && d.item === item)
      .reduce((a, d) => a + storageResults[d.id]!.producedPerSecond, 0);
    const net = produced + imported - consumed - product;
    resources[key(item)] = {
      key: key(item),
      kind: "item",
      resourceId: item,
      displayName: item,
      producedPerSecond: produced,
      consumedPerSecond: consumed,
      netPerSecond: produced - consumed,
      surplusPerSecond: Math.max(0, net),
      deficitPerSecond: Math.max(0, -net),
      importedPerSecond: imported,
      productPerSecond: product,
      byproductPerSecond: 0,
      bufferFillPerSecond: 0,
    };
  }

  return {
    name: spec.name,
    description: spec.description,
    project,
    result: {
      nodes: nodeResults,
      storages: storageResults,
      resources,
      edges: edgeResults,
      totalEuT,
      totalEuPerSecond: totalEuT * 20,
      bottlenecks: [],
      externalInputs: [],
      unconsumedOutputs: [],
      generatedAt: "mock",
      plan: spec.extras,
    },
  };
}

const out = (nodeId: string, item: string) => makePortKey(nodeId, "o", handle("output", item));
const inn = (nodeId: string, item: string) => makePortKey(nodeId, "i", handle("input", item));

// ---------------------------------------------------------------------------
// 1. Forced inputs and outputs at ports
// ---------------------------------------------------------------------------

export const mockForced: MockPlan = build({
  id: "mock-forced",
  name: "Forced flows",
  description: "Dust leaves a port with no drawer; coal enters another; the product drawer is met.",
  recipes: [
    { id: "Macerator", inputs: [["Iron Ore", 1]], outputs: [["Crushed Iron", 2]] },
    {
      id: "Furnace",
      inputs: [
        ["Crushed Iron", 3],
        ["Coal", 1],
      ],
      outputs: [
        ["Iron Ingot", 2],
        ["Slag", 1],
      ],
    },
    { id: "Slag Washer", inputs: [["Slag", 2]], outputs: [["Clay", 1]] },
    { id: "Coal Maker", inputs: [["Wood", 1]], outputs: [["Coal", 1]] },
  ],
  nodes: [
    { id: "mac", recipe: "Macerator", count: 3, pin: 3, exact: true, x: 0, y: 0 },
    { id: "furn", recipe: "Furnace", count: 1, x: 480, y: 0 },
    { id: "wash", recipe: "Slag Washer", count: 0.5, x: 960, y: 120 },
    { id: "coal", recipe: "Coal Maker", count: 0.5, pin: 0.5, exact: true, x: 0, y: 300 },
  ],
  drawers: [
    { id: "ore", item: "Iron Ore", kind: "source", x: -240, y: 0 },
    { id: "wood", item: "Wood", kind: "source", x: -240, y: 300 },
    { id: "ingots", item: "Iron Ingot", kind: "product", rate: 2, mode: "at-least", x: 960, y: 0 },
  ],
  wires: [
    { id: "w-ore", from: "ore", to: "mac", item: "Iron Ore", perSecond: 3 },
    { id: "w-wood", from: "wood", to: "coal", item: "Wood", perSecond: 0.5 },
    { id: "w-dust", from: "mac", to: "furn", item: "Crushed Iron", perSecond: 3 },
    { id: "w-coal", from: "coal", to: "furn", item: "Coal", perSecond: 0.5 },
    { id: "w-ingot", from: "furn", to: "ingots", item: "Iron Ingot", perSecond: 2 },
    { id: "w-slag", from: "furn", to: "wash", item: "Slag", perSecond: 1 },
  ],
  extras: {
    forced: [
      // The macerator makes 6 dust a second and the furnace takes 3.
      {
        nodeId: "mac",
        portKey: out("mac", "Crushed Iron"),
        side: "out",
        resourceKey: "item:Crushed Iron",
        perSecond: 3,
      },
      // The furnace wants a coal a second and the coal maker makes half of that.
      {
        nodeId: "furn",
        portKey: inn("furn", "Coal"),
        side: "in",
        resourceKey: "item:Coal",
        perSecond: 0.5,
      },
    ],
    leftovers: [],
    unneeded: [],
    unanchored: [],
    terminals: [],
    notes: [],
    openGates: 2,
  },
});

// ---------------------------------------------------------------------------
// 2. Leftovers and spares
// ---------------------------------------------------------------------------

const shortfallBearers = [inn("alloy", "Copper Dust"), inn("alloy2", "Copper Dust")];
const shortfallKey = makeLeftoverKey(shortfallBearers);
const surplusBearers = [out("crush", "Tin Dust"), out("crush2", "Tin Dust")];
const surplusKey = makeLeftoverKey(surplusBearers);

const leftoversA: PlanLeftover = {
  key: shortfallKey,
  importing: true,
  custom: true,
  bearers: [
    {
      portKey: shortfallBearers[0]!,
      maxPerSecond: 4,
      share: 0.25,
      solverPick: true,
      flows: [{ portKey: shortfallBearers[0]!, perSecond: 1 }],
    },
    {
      portKey: shortfallBearers[1]!,
      maxPerSecond: 4,
      share: 0.75,
      solverPick: false,
      flows: [{ portKey: shortfallBearers[1]!, perSecond: 3 }],
    },
  ],
};

const leftoversB: PlanLeftover = {
  key: surplusKey,
  importing: false,
  custom: false,
  bearers: [
    {
      portKey: surplusBearers[0]!,
      maxPerSecond: 2,
      share: 1,
      solverPick: true,
      flows: [{ portKey: surplusBearers[0]!, perSecond: 2 }],
    },
    {
      portKey: surplusBearers[1]!,
      maxPerSecond: 2,
      share: 0,
      solverPick: false,
      flows: [],
    },
  ],
};

export const mockLeftovers: MockPlan = build({
  id: "mock-leftovers",
  name: "Leftovers and spares",
  description:
    "A shortfall two inputs could bear (stored 25/75) and a surplus with two places to go.",
  recipes: [
    { id: "Alloy Smelter", inputs: [["Copper Dust", 4]], outputs: [["Bronze Ingot", 1]] },
    { id: "Crusher", inputs: [["Tin Ore", 1]], outputs: [["Tin Dust", 2]] },
  ],
  nodes: [
    { id: "alloy", recipe: "Alloy Smelter", count: 1, pin: 1, exact: true, x: 480, y: 0 },
    { id: "alloy2", recipe: "Alloy Smelter", count: 1, pin: 1, exact: true, x: 480, y: 300 },
    { id: "crush", recipe: "Crusher", count: 1, pin: 1, exact: true, x: 0, y: 600 },
    { id: "crush2", recipe: "Crusher", count: 1, pin: 1, exact: true, x: 480, y: 600 },
  ],
  drawers: [
    { id: "bronze", item: "Bronze Ingot", kind: "product", x: 960, y: 150 },
    { id: "tin-ore", item: "Tin Ore", kind: "source", x: -240, y: 600 },
  ],
  wires: [
    { id: "w-b1", from: "alloy", to: "bronze", item: "Bronze Ingot", perSecond: 1 },
    { id: "w-b2", from: "alloy2", to: "bronze", item: "Bronze Ingot", perSecond: 1 },
    { id: "w-t1", from: "tin-ore", to: "crush", item: "Tin Ore", perSecond: 1 },
    { id: "w-t2", from: "tin-ore", to: "crush2", item: "Tin Ore", perSecond: 1 },
  ],
  // The stored split is keyed by the leftover's key, then each bearer's key.
  spareShares: {
    [shortfallKey]: { [shortfallBearers[0]!]: 0.25, [shortfallBearers[1]!]: 0.75 },
  },
  extras: {
    forced: [
      {
        nodeId: "alloy",
        portKey: shortfallBearers[0]!,
        side: "in",
        resourceKey: "item:Copper Dust",
        perSecond: 1,
      },
      {
        nodeId: "alloy2",
        portKey: shortfallBearers[1]!,
        side: "in",
        resourceKey: "item:Copper Dust",
        perSecond: 3,
      },
      {
        nodeId: "crush",
        portKey: surplusBearers[0]!,
        side: "out",
        resourceKey: "item:Tin Dust",
        perSecond: 2,
      },
    ],
    leftovers: [leftoversA, leftoversB],
    unneeded: [],
    unanchored: [],
    terminals: [],
    notes: [],
    openGates: 3,
  },
});

// ---------------------------------------------------------------------------
// 3. Unneeded machines and unanchored parts
// ---------------------------------------------------------------------------

export const mockUnneeded: MockPlan = build({
  id: "mock-unneeded",
  name: "Unneeded and unanchored",
  description:
    "A machine nothing feeds or needs sits at zero; a separate sawmill line has no number anywhere; the steel drawer asks for more than the line can make.",
  recipes: [
    { id: "Compressor", inputs: [["Iron Ingot", 2]], outputs: [["Steel Plate", 1]] },
    { id: "Spare Cutter", inputs: [["Steel Plate", 1]], outputs: [["Steel Rod", 2]] },
    { id: "Sawmill", inputs: [["Log", 1]], outputs: [["Plank", 4]] },
  ],
  nodes: [
    { id: "comp", recipe: "Compressor", count: 6, pin: 6, x: 0, y: 0 },
    { id: "cutter", recipe: "Spare Cutter", count: 0, x: 480, y: 0 },
    { id: "saw", recipe: "Sawmill", count: 0, x: 0, y: 450 },
  ],
  drawers: [
    { id: "iron", item: "Iron Ingot", kind: "source", rate: 12, mode: "at-most", x: -240, y: 0 },
    { id: "steel", item: "Steel Plate", kind: "product", rate: 10, mode: "at-least", x: 960, y: 0 },
    { id: "rods", item: "Steel Rod", kind: "product", x: 960, y: 200 },
    { id: "logs", item: "Log", kind: "source", x: -240, y: 450 },
    { id: "planks", item: "Plank", kind: "product", x: 480, y: 450 },
  ],
  wires: [
    { id: "w-iron", from: "iron", to: "comp", item: "Iron Ingot", perSecond: 12 },
    { id: "w-steel", from: "comp", to: "steel", item: "Steel Plate", perSecond: 6 },
    { id: "w-cut-in", from: "comp", to: "cutter", item: "Steel Plate", perSecond: 0 },
    { id: "w-rods", from: "cutter", to: "rods", item: "Steel Rod", perSecond: 0 },
    { id: "w-log", from: "logs", to: "saw", item: "Log", perSecond: 0 },
    { id: "w-plank", from: "saw", to: "planks", item: "Plank", perSecond: 0 },
  ],
  extras: {
    forced: [],
    leftovers: [],
    unneeded: ["cutter"],
    unanchored: ["saw", "logs", "planks"],
    terminals: [],
    notes: [
      {
        message: "DRAWER_UNMET",
        args: ["Steel Plate", { message: "RULE_AT_LEAST", args: [] }, 10, 6],
      },
      {
        message: "DRAWER_LIMITED_BY",
        args: ["Steel Plate", { message: "LIMIT_DRAWER", args: ["Iron Ingot"] }],
      },
    ],
    openGates: 0,
    unmetDrawers: ["steel"],
  },
});

// ---------------------------------------------------------------------------
// 4. Up to counts: every reason, an Exactly card with a forced input, Any
// ---------------------------------------------------------------------------

export const mockUpTo: MockPlan = build({
  id: "mock-up-to",
  name: "Up to counts",
  description:
    "Every Up to reason (full, bottleneck, starved, clogged, unused, limited, no reason), an Exactly card fed by a forced input, an Exactly card with nothing forced, and an Any card.",
  recipes: [
    {
      id: "Pyrolyse Oven",
      inputs: [["Log", 1]],
      outputs: [
        ["Charcoal", 1],
        ["Wood Tar", 3],
      ],
    },
    {
      id: "Distillery",
      inputs: [["Wood Tar", 9]],
      outputs: [
        ["Creosote", 4],
        ["Benzene", 2],
      ],
      circuit: "24",
    },
    { id: "Mixer", inputs: [["Dust", 1]], outputs: [["Mix", 1]] },
    { id: "Packer", inputs: [["Mix", 2]], outputs: [["Pack", 1]] },
    { id: "Centrifuge", inputs: [["Slime", 1]], outputs: [["Rubber", 1]] },
    { id: "Assembler", inputs: [["Plate", 2]], outputs: [["Gear", 1]] },
    { id: "Oxygen Plant", inputs: [["Air", 1]], outputs: [["Oxygen", 1]] },
    { id: "Burner", inputs: [["Oxygen", 1]], outputs: [["Heat", 1]] },
  ],
  nodes: [
    // The line: two ovens run flat out and still cannot keep the tower busy.
    { id: "oven", recipe: "Pyrolyse Oven", count: 2, pin: 2, utilization: 1, x: 0, y: 0 },
    { id: "tower", recipe: "Distillery", count: 2 / 3, pin: 1, utilization: 2 / 3, x: 480, y: 0 },
    // Half the mixers' output has nowhere to go: the one packer takes 2 a second.
    { id: "clog", recipe: "Mixer", count: 2, pin: 4, utilization: 0.5, x: 0, y: 420 },
    { id: "taker", recipe: "Packer", count: 1, pin: 1, utilization: 1, x: 480, y: 420 },
    // Nothing takes the rubber; the gears' drawer holds the assemblers to 3; one card's reason ran out of time.
    { id: "idle", recipe: "Centrifuge", count: 0, pin: 3, utilization: 0, x: 0, y: 840 },
    { id: "held", recipe: "Assembler", count: 3, pin: 5, utilization: 0.6, x: 480, y: 840 },
    { id: "slow", recipe: "Assembler", count: 4.5, pin: 6, utilization: 0.75, x: 960, y: 840 },
    // An Exactly card the oxygen plants cannot keep up with: the gap comes in forced.
    { id: "feeder", recipe: "Oxygen Plant", count: 3, pin: 3, utilization: 1, x: 0, y: 1260 },
    { id: "exact", recipe: "Burner", count: 4, pin: 4, exact: true, x: 480, y: 1260 },
    { id: "exact2", recipe: "Burner", count: 2, pin: 2, exact: true, x: 480, y: 1560 },
    { id: "any", recipe: "Burner", count: 1.5, x: 960, y: 1560 },
    // A shared machine: mixing and packing in turns on up to 3 machines, short of dust.
    {
      id: "shared",
      recipe: "Mixer",
      count: 1.5,
      pin: 3,
      utilization: 2.5 / 3,
      sections: [{ recipe: "Packer", count: 1 }],
      x: 960,
      y: 1160,
    },
  ],
  drawers: [
    { id: "logs", item: "Log", kind: "source", x: -240, y: 0 },
    { id: "dust", item: "Dust", kind: "source", x: -240, y: 420 },
    { id: "slime", item: "Slime", kind: "source", x: -240, y: 840 },
    { id: "rubber", item: "Rubber", kind: "product", rate: 0, mode: "at-most", x: 360, y: 840 },
    { id: "plates", item: "Plate", kind: "source", x: 240, y: 1100 },
    { id: "gears", item: "Gear", kind: "product", rate: 3, mode: "exact", x: 860, y: 760 },
    { id: "air", item: "Air", kind: "source", x: -240, y: 1260 },
    { id: "oxygen", item: "Oxygen", kind: "source", x: 240, y: 1640 },
    { id: "dust2", item: "Dust", kind: "source", x: 720, y: 1160 },
  ],
  wires: [
    { id: "w-log", from: "logs", to: "oven", item: "Log", perSecond: 2 },
    { id: "w-tar", from: "oven", to: "tower", item: "Wood Tar", perSecond: 6 },
    { id: "w-dust2", from: "dust", to: "clog", item: "Dust", perSecond: 2 },
    { id: "w-mix", from: "clog", to: "taker", item: "Mix", perSecond: 2 },
    { id: "w-slime", from: "slime", to: "idle", item: "Slime", perSecond: 0 },
    { id: "w-rubber", from: "idle", to: "rubber", item: "Rubber", perSecond: 0 },
    { id: "w-plate1", from: "plates", to: "held", item: "Plate", perSecond: 6 },
    { id: "w-plate2", from: "plates", to: "slow", item: "Plate", perSecond: 9 },
    { id: "w-gear", from: "held", to: "gears", item: "Gear", perSecond: 3 },
    { id: "w-air", from: "air", to: "feeder", item: "Air", perSecond: 3 },
    { id: "w-oxy", from: "feeder", to: "exact", item: "Oxygen", perSecond: 3 },
    { id: "w-oxy2", from: "oxygen", to: "exact2", item: "Oxygen", perSecond: 2 },
    { id: "w-oxy3", from: "oxygen", to: "any", item: "Oxygen", perSecond: 1.5 },
    { id: "w-dust3", from: "dust2", to: "shared", item: "Dust", perSecond: 1.5 },
  ],
  extras: {
    upTo: {
      oven: { capacity: 2, reached: 2, reason: "BOTTLENECK", wants: 3 },
      tower: {
        capacity: 1,
        reached: 2 / 3,
        reason: "STARVED",
        portKey: inn("tower", "Wood Tar"),
        resourceKey: "item:Wood Tar",
        upstream: ["oven"],
      },
      clog: {
        capacity: 4,
        reached: 2,
        reason: "CLOGGED",
        portKey: out("clog", "Mix"),
        resourceKey: "item:Mix",
      },
      taker: { capacity: 1, reached: 1, reason: "FULL" },
      idle: {
        capacity: 3,
        reached: 0,
        reason: "UNUSED",
        portKey: out("idle", "Rubber"),
        resourceKey: "item:Rubber",
      },
      held: { capacity: 5, reached: 3, reason: "LIMITED" },
      slow: { capacity: 6, reached: 4.5, reason: null },
      // The Exactly burner's forced oxygen over one plant's 1 a second: the line wants one more.
      feeder: { capacity: 3, reached: 3, reason: "BOTTLENECK", wants: 4 },
      // A shared card's pool, under the card's id.
      shared: {
        capacity: 3,
        reached: 2.5,
        reason: "STARVED",
        portKey: inn("shared", "Dust"),
        resourceKey: "item:Dust",
      },
    },
    forced: [
      // The burners want 4 oxygen a second and the plants make 3.
      {
        nodeId: "exact",
        portKey: inn("exact", "Oxygen"),
        side: "in",
        resourceKey: "item:Oxygen",
        perSecond: 1,
      },
    ],
    leftovers: [],
    unneeded: [],
    unanchored: [],
    terminals: [],
    notes: [],
    openGates: 1,
  },
});

// ---------------------------------------------------------------------------
// 5. Old Build's rings: a dead loop and a clog lock
// ---------------------------------------------------------------------------

export const mockLoops: MockPlan = build({
  id: "mock-loops",
  name: "Dead loop and clog lock",
  description:
    "Three Up to cards in a ring with nothing feeding it (a dead loop), and two that feed each other and are stuck on a surplus of hydrogen (a clog lock).",
  recipes: [
    {
      id: "Ring Electrolysis",
      machine: "Electrolyzer",
      inputs: [["Sludge", 1]],
      outputs: [["Gas", 1]],
    },
    {
      id: "Ring Reaction",
      machine: "Chemical Reactor",
      inputs: [["Gas", 1]],
      outputs: [["Slurry", 1]],
    },
    { id: "Ring Mixing", machine: "Mixer", inputs: [["Slurry", 1]], outputs: [["Sludge", 1]] },
    {
      id: "Water Splitting",
      machine: "Electrolyzer",
      inputs: [["Water", 1]],
      outputs: [
        ["Hydrogen", 2],
        ["Oxygen", 1],
      ],
    },
    {
      id: "Water Making",
      machine: "Mixer",
      inputs: [
        ["Hydrogen", 1],
        ["Oxygen", 1],
      ],
      outputs: [["Water", 1]],
    },
  ],
  nodes: [
    { id: "ra", recipe: "Ring Electrolysis", count: 0, pin: 2, utilization: 0, x: 0, y: 0 },
    { id: "rb", recipe: "Ring Reaction", count: 0, pin: 2, utilization: 0, x: 480, y: 0 },
    { id: "rc", recipe: "Ring Mixing", count: 0, pin: 2, utilization: 0, x: 240, y: 300 },
    { id: "split", recipe: "Water Splitting", count: 0, pin: 2, utilization: 0, x: 0, y: 700 },
    { id: "make", recipe: "Water Making", count: 0, pin: 2, utilization: 0, x: 480, y: 700 },
  ],
  drawers: [],
  wires: [
    { id: "w-ab", from: "ra", to: "rb", item: "Gas", perSecond: 0 },
    { id: "w-bc", from: "rb", to: "rc", item: "Slurry", perSecond: 0 },
    { id: "w-ca", from: "rc", to: "ra", item: "Sludge", perSecond: 0 },
    { id: "w-h", from: "split", to: "make", item: "Hydrogen", perSecond: 0 },
    { id: "w-o", from: "split", to: "make", item: "Oxygen", perSecond: 0 },
    { id: "w-w", from: "make", to: "split", item: "Water", perSecond: 0 },
  ],
  extras: {
    upTo: {
      ra: {
        capacity: 2,
        reached: 0,
        reason: "STARVED",
        portKey: inn("ra", "Sludge"),
        resourceKey: "item:Sludge",
      },
      rb: {
        capacity: 2,
        reached: 0,
        reason: "STARVED",
        portKey: inn("rb", "Gas"),
        resourceKey: "item:Gas",
      },
      rc: {
        capacity: 2,
        reached: 0,
        reason: "STARVED",
        portKey: inn("rc", "Slurry"),
        resourceKey: "item:Slurry",
      },
      // A clog lock's cards stand still, each on what it cannot get rid of: UNUSED, as the solver reads them.
      split: {
        capacity: 2,
        reached: 0,
        reason: "UNUSED",
        portKey: out("split", "Hydrogen"),
        resourceKey: "item:Hydrogen",
      },
      make: {
        capacity: 2,
        reached: 0,
        reason: "UNUSED",
        portKey: out("make", "Water"),
        resourceKey: "item:Water",
      },
    },
    loops: [
      {
        kind: "DEAD_LOOP",
        cards: ["ra", "rb", "rc"],
        portKeys: [inn("ra", "Sludge"), inn("rb", "Gas"), inn("rc", "Slurry")],
        resourceKeys: ["item:Sludge", "item:Gas", "item:Slurry"],
      },
      {
        kind: "CLOG_LOCK",
        cards: ["split", "make"],
        portKeys: [out("split", "Hydrogen"), out("make", "Water")],
        resourceKeys: ["item:Hydrogen", "item:Water"],
      },
    ],
    forced: [],
    leftovers: [],
    unneeded: [],
    unanchored: [],
    terminals: [],
    notes: [],
    openGates: 0,
  },
});

export const mockPlans: MockPlan[] = [mockForced, mockLeftovers, mockUnneeded, mockUpTo, mockLoops];
