import { describe, expect, it } from "vitest";
import { calculateThroughput } from "@/lib/solver/throughput";
import { rectsOverlap } from "@/components/flow/board-placement";
import { RECIPE_NODE_WIDTH, BOARD_GRID } from "@/lib/board-grid";
import { useFactoryStore } from "@/store/factory-store";
import { CELL_WIRE_TANK_RECIPE_PREFIX, convertLooseCellWires } from "./cell-wires";
import { getFluidTankSlot, isFluidTankRecipe } from "./fluid-tank";
import { normalizeLoadedProject, normalizeLoadedProjectWithNotice } from "./project-normalize";
import { PROJECT_SCHEMA_VERSION, type FactoryEdge, type FactoryNode, type FactoryProject, type Recipe } from "./types";

/**
 * Loose cell wires (a cell wired straight into its fluid's slot, or a fluid into its cell's) are gone: an older plan's
 * become fluid tank cards where the plan lands. The numbers each plan must keep are the ones the old hidden tank gave
 * the same boards, recorded before it was removed.
 */

const CELL = { kind: "item" as const, id: "gregtech:gt.metaitem.01@30001", displayName: "Water Cell", iconPath: "/cell.png" };
const WATER = { kind: "fluid" as const, id: "water", displayName: "Water", iconPath: "/water.png" };

const FILLER: Recipe = {
  id: "fill", name: "fill", machineType: "Bender", minimumTier: "LV", durationTicks: 20, eut: 30,
  inputs: [], outputs: [{ ...CELL, amount: 2 }],
};
const DRINKER: Recipe = {
  id: "drink", name: "drink", machineType: "Bender", minimumTier: "LV", durationTicks: 20, eut: 30,
  inputs: [{ ...WATER, amount: 1000 }], outputs: [{ kind: "item", id: "sponge", amount: 1 }],
};
const PUMP: Recipe = {
  id: "pump", name: "pump", machineType: "Bender", minimumTier: "LV", durationTicks: 20, eut: 30,
  inputs: [], outputs: [{ ...WATER, amount: 2000 }],
};
const EATER: Recipe = {
  id: "eat", name: "eat", machineType: "Bender", minimumTier: "LV", durationTicks: 20, eut: 30,
  inputs: [{ ...CELL, amount: 1 }], outputs: [{ kind: "item", id: "sponge", amount: 1 }],
};

function node(id: string, recipeId: string, extra: Partial<FactoryNode> = {}): FactoryNode {
  return { id, recipeId, machineCount: 1, parallel: 1, overclockTier: "LV", enabled: true, position: { x: 0, y: 0 }, ...extra };
}

const handle = (side: "input" | "output", r: { kind: string; id: string }) => `${side}:${r.kind}:${encodeURIComponent(r.id)}`;

/** maker -> taker by one loose cell wire, the taker's product in a drawer; `pin` sets one card's count (Up to). */
function loosePlan(emptying: boolean, pin: "maker" | "taker", litresPerCell = 1000, over: Partial<FactoryProject> = {}): FactoryProject {
  const from = emptying ? CELL : WATER;
  const to = emptying ? WATER : CELL;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "loose",
    name: "loose",
    solveMode: true,
    planMode: true,
    recipes: emptying ? [FILLER, DRINKER] : [PUMP, EATER],
    nodes: [
      node("maker", emptying ? "fill" : "pump", { position: { x: 0, y: 0 }, ...(pin === "maker" ? { solvePin: 1 } : {}) }),
      node("taker", emptying ? "drink" : "eat", { position: { x: 400, y: 0 }, ...(pin === "taker" ? { solvePin: 1 } : {}) }),
    ],
    storages: [{ id: "d", kind: "item", resourceId: "sponge", position: { x: 800, y: 0 } }],
    edges: [
      {
        id: "w", source: "maker", target: "taker", label: from.displayName,
        sourceHandle: handle("output", from), targetHandle: handle("input", to),
        resourceKind: from.kind, resourceId: from.id, crossForm: { litresPerCell },
      },
      { id: "out", source: "taker", target: "d", sourceHandle: "output:item:sponge", resourceKind: "item", resourceId: "sponge" },
    ],
    fuelProfiles: [],
    ...over,
  } as FactoryProject;
}

function rates(project: FactoryProject) {
  const result = calculateThroughput(project, { generatedAt: "fixed" });
  const act = (id: string) => Number(result.nodes[id]!.theoreticalMachinesRequired.toFixed(6));
  const flow = (id: string) => Number(result.edges[id]!.transferredPerSecond.toFixed(6));
  return { act, flow, result };
}

describe("loose cell wires become fluid tanks", () => {
  // [emptying, pinned card, maker's act, taker's act, cells a second through the tank], as the hidden tank solved them.
  const recorded: Array<[boolean, "maker" | "taker", number, number, number]> = [
    [true, "maker", 1, 2, 2],
    [true, "taker", 0.5, 1, 1],
    [false, "maker", 1, 2, 2],
    [false, "taker", 0.5, 1, 1],
  ];
  it.each(recorded)("keeps the plan's numbers (emptying %s, %s pinned)", (emptying, pin, makerAct, takerAct, cells) => {
    const { project, notice } = normalizeLoadedProjectWithNotice(loosePlan(emptying, pin));
    expect(project.edges.some((edge) => edge.crossForm)).toBe(false);
    const { act, flow } = rates(project);
    expect(act("maker")).toBeCloseTo(makerAct, 6);
    expect(act("taker")).toBeCloseTo(takerAct, 6);
    // The wire the player drew still carries its own form; the tank's carries the other at the Canner's litres.
    expect(flow("w")).toBeCloseTo(emptying ? cells : cells * 1000, 6);
    expect(flow("w:tank")).toBeCloseTo(emptying ? cells * 1000 : cells, 6);
    expect(flow("out")).toBeCloseTo(takerAct, 6);
    expect(notice).toEqual({
      origin: "plan",
      text: "1 cell wire now goes through a fluid tank.",
      details: ["Cells no longer wire straight into fluid slots."],
    });
  });

  it("converts at the wire's own litres a cell", () => {
    // 2 cells a second at 250 L is 500 L: half of what the drinker asks.
    const { act, flow } = rates(normalizeLoadedProject(loosePlan(true, "maker", 250)));
    expect(act("taker")).toBeCloseTo(0.5, 6);
    expect(flow("w:tank")).toBeCloseTo(500, 6);
  });

  it("puts in the dataset's Tank: the cell, its fluid and its empty cell, free and a tick a craft", () => {
    const emptying = normalizeLoadedProject(loosePlan(true, "maker"));
    const tank = emptying.nodes.find((entry) => entry.id === "cell-tank:w")!;
    const recipe = emptying.recipes.find((entry) => entry.id === tank.recipeId)!;
    expect(tank).toMatchObject({ machineCount: 1, overclockTier: "NONE", enabled: true });
    expect(tank.solvePin).toBeUndefined();
    expect(isFluidTankRecipe(recipe)).toBe(true);
    expect(recipe.id.startsWith(CELL_WIRE_TANK_RECIPE_PREFIX)).toBe(true);
    expect(recipe).toMatchObject({ name: "Tank: Empty Cell", machineType: "Tank", durationTicks: 1, eut: 0, minimumTier: "NONE" });
    // What the mod's importer reads it by (FfPlan.isPlannerTank): the map planner.tank.
    expect(recipe.metadata?.recipeMapId).toBe("planner.tank");
    expect(recipe.source?.rawRecipeId?.startsWith("planner.tank:")).toBe(true);
    expect(recipe.inputs.map((slot) => [slot.kind, slot.id, slot.amount])).toEqual([["item", CELL.id, 1]]);
    // The fluid first: the landing refresh finds the dataset's own Tank by its first output.
    expect(recipe.outputs.map((slot) => [slot.kind, slot.id, slot.amount])).toEqual([
      ["fluid", "water", 1000],
      ["item", "ic2:itemcellempty", 1],
    ]);
    // Faces come from the slots the wire joined.
    expect(recipe.inputs[0]).toMatchObject({ displayName: "Water Cell", iconPath: "/cell.png" });
    expect(recipe.outputs[0]).toMatchObject({ displayName: "Water", iconPath: "/water.png" });
    expect(getFluidTankSlot(recipe)?.mode).toBe("empty");

    const filling = normalizeLoadedProject(loosePlan(false, "maker"));
    const fill = filling.recipes.find((entry) => entry.id === filling.nodes.find((n) => n.id === "cell-tank:w")!.recipeId)!;
    expect(fill.inputs.map((slot) => [slot.kind, slot.id, slot.amount])).toEqual([
      ["item", "ic2:itemcellempty", 1],
      ["fluid", "water", 1000],
    ]);
    expect(fill.outputs.map((slot) => [slot.kind, slot.id])).toEqual([["item", CELL.id]]);
    expect(fill.name).toBe("Tank: Water Cell");
    expect(getFluidTankSlot(fill)?.mode).toBe("fill");
  });

  it("wires the tank by the two ends' own ports", () => {
    const project = normalizeLoadedProject(loosePlan(true, "maker"));
    const wires = project.edges.filter((edge) => edge.id !== "out");
    expect(wires).toEqual([
      expect.objectContaining({
        id: "w", source: "maker", target: "cell-tank:w",
        sourceHandle: handle("output", CELL), targetHandle: handle("input", CELL),
        resourceKind: "item", resourceId: CELL.id,
      }),
      expect.objectContaining({
        id: "w:tank", source: "cell-tank:w", target: "taker",
        sourceHandle: handle("output", WATER), targetHandle: handle("input", WATER),
        resourceKind: "fluid", resourceId: "water", label: "Water",
      }),
    ]);
  });

  it("places the tank clear of every card, on the fed card's board", () => {
    const board = { id: "board", name: "Board", position: { x: 0, y: 0 }, expanded: true, size: { width: 2000, height: 1000 } };
    const crowded = loosePlan(true, "maker", 1000, {
      pockets: [board],
      nodes: [
        node("maker", "fill", { position: { x: 0, y: 0 }, pocketId: "board", solvePin: 1 }),
        node("taker", "drink", { position: { x: 400, y: 0 }, pocketId: "board" }),
        node("other", "drink", { position: { x: 200, y: 300 }, pocketId: "board" }),
      ],
    });
    const project = convertLooseCellWires(crowded).project;
    const tank = project.nodes.find((entry) => entry.id === "cell-tank:w")!;
    expect(tank.pocketId).toBe("board");
    expect(Number.isInteger(tank.position.x / BOARD_GRID)).toBe(true);
    expect(Number.isInteger(tank.position.y / BOARD_GRID)).toBe(true);
    const box = (n: FactoryNode) => ({ ...n.position, width: RECIPE_NODE_WIDTH, height: BOARD_GRID * 14 });
    for (const other of project.nodes.filter((entry) => entry !== tank)) {
      expect(rectsOverlap(box(tank), box(other))).toBe(false);
    }
  });

  it("gives each wire its own tank, two tanks never on top of each other", () => {
    const two = loosePlan(true, "maker");
    two.nodes.push(node("taker2", "drink", { position: { x: 400, y: 400 } }));
    two.edges.push({ ...two.edges[0]!, id: "w2", target: "taker2" });
    const project = convertLooseCellWires(two).project;
    const tanks = project.nodes.filter((entry) => entry.id.startsWith("cell-tank:"));
    expect(tanks.map((entry) => entry.id)).toEqual(["cell-tank:w", "cell-tank:w2"]);
    // One recipe serves both: same cell, fluid and litres.
    expect(new Set(tanks.map((entry) => entry.recipeId)).size).toBe(1);
    const box = (n: FactoryNode) => ({ ...n.position, width: RECIPE_NODE_WIDTH, height: BOARD_GRID * 14 });
    expect(rectsOverlap(box(tanks[0]!), box(tanks[1]!))).toBe(false);
  });

  it("lands on a shared machine's recipe by the section its wire named", () => {
    const shared = loosePlan(true, "maker");
    shared.recipes.push({ ...DRINKER, id: "other", inputs: [], outputs: [] });
    shared.nodes[1] = { ...shared.nodes[1]!, recipeId: "other", extraRecipes: [{ recipeId: "drink" }] };
    shared.edges[0] = { ...shared.edges[0]!, targetHandle: `r1:${handle("input", WATER)}` };
    shared.edges[1] = { ...shared.edges[1]!, source: "taker", sourceHandle: "r1:output:item:sponge" };
    const project = normalizeLoadedProject(shared);
    const out = project.edges.find((edge) => edge.id === "w:tank")!;
    expect(out.targetHandle).toBe(`r1:${handle("input", WATER)}`);
    expect(rates(project).flow("w:tank")).toBeCloseTo(2000, 6);
  });

  it("stands a tank between a drawer and a card too", () => {
    const fromDrawer = loosePlan(true, "taker", 1000, {
      nodes: [node("taker", "drink", { position: { x: 400, y: 0 }, solvePin: 1 })],
      storages: [
        { id: "cells", kind: "item", resourceId: CELL.id, displayName: "Water Cell", position: { x: 0, y: 0 } },
        { id: "d", kind: "item", resourceId: "sponge", position: { x: 800, y: 0 } },
      ],
    });
    fromDrawer.edges[0] = { ...fromDrawer.edges[0]!, source: "cells", sourceHandle: undefined };
    const project = normalizeLoadedProject(fromDrawer);
    expect(project.edges.find((edge) => edge.id === "w")).toMatchObject({ source: "cells", target: "cell-tank:w" });
    const { act, flow } = rates(project);
    expect(act("taker")).toBeCloseTo(1, 6);
    expect(flow("w")).toBeCloseTo(1, 6);
  });

  it("drops a wire no tank could stand in: no litres, or an end that is gone", () => {
    const broken = loosePlan(true, "maker");
    broken.edges.push({ ...broken.edges[0]!, id: "zero", crossForm: { litresPerCell: 0 } });
    broken.edges.push({ ...broken.edges[0]!, id: "gone", target: "nobody" });
    const { project, converted } = convertLooseCellWires(broken);
    expect(converted).toBe(1);
    expect(project.edges.map((edge) => edge.id)).toEqual(["w", "w:tank", "out"]);
  });

  it("is the same plan twice: a plan with nothing to convert comes back as the same object", () => {
    const once = convertLooseCellWires(loosePlan(true, "maker")).project;
    const twice = convertLooseCellWires(once);
    expect(twice.project).toBe(once);
    expect(twice.converted).toBe(0);
    // Two screens converting the same plan write the same things.
    expect(convertLooseCellWires(loosePlan(true, "maker")).project).toEqual(once);
  });

  it("keeps a checked wire checked on both halves", () => {
    const checked = loosePlan(true, "maker", 1000, { checklist: { cards: [], edges: ["w"] } });
    expect(convertLooseCellWires(checked).project.checklist?.edges).toEqual(["w", "w:tank"]);
  });

  it("adds a line to an older mode's notice", () => {
    const build = loosePlan(true, "maker");
    delete build.planMode;
    delete build.solveMode;
    const { project, notice } = normalizeLoadedProjectWithNotice(build);
    expect(project.planMode).toBe(true);
    expect(project.nodes.find((entry) => entry.id === "cell-tank:w")?.solvePin).toBeUndefined();
    expect(notice?.text).toBe("Converted from a Build plan.");
    expect(notice?.details).toContain("1 cell wire now goes through a fluid tank.");
  });
});

describe("the board takes no loose cell wires", () => {
  it("a live plan carrying one converts on landing, once, and hands the conversion back to be sent", () => {
    const plain = normalizeLoadedProject(loosePlan(true, "maker"));
    useFactoryStore.getState().markHydratedProject(plain);
    const wire: FactoryEdge = loosePlan(true, "maker").edges[0]!;
    // Someone on an older build puts the wire back.
    const conversion = useFactoryStore.getState().applyLiveOps([
      { o: "del", c: "edges", id: "w" },
      { o: "del", c: "edges", id: "w:tank" },
      { o: "del", c: "nodes", id: "cell-tank:w" },
      { o: "put", c: "edges", id: "w", v: wire as unknown as { id: string } },
    ]);
    expect(conversion).toBeDefined();
    const after = useFactoryStore.getState().project;
    expect(after.edges.some((edge) => edge.crossForm)).toBe(false);
    expect(after.nodes.some((entry) => entry.id === "cell-tank:w")).toBe(true);
    expect(useFactoryStore.getState().planNotice?.text).toBe("1 cell wire now goes through a fluid tank.");
    // Nothing more to send once it is converted.
    expect(useFactoryStore.getState().applyLiveOps([{ o: "meta", f: { name: "renamed" } }])).toBeUndefined();
  });

  it("a paste of an older build's copy brings a tank, not the wire", () => {
    useFactoryStore.getState().markHydratedProject(normalizeLoadedProject({ ...loosePlan(true, "maker"), nodes: [], edges: [], storages: [] }));
    const old = loosePlan(true, "maker");
    useFactoryStore.getState().pasteBoardItems(
      { nodes: old.nodes, storages: [], annotations: [], pockets: [], edges: [old.edges[0]!], recipes: old.recipes },
      { x: 0, y: 0 },
    );
    const pasted = useFactoryStore.getState().project;
    expect(pasted.edges.some((edge) => edge.crossForm)).toBe(false);
    expect(pasted.nodes).toHaveLength(3);
    const tank = pasted.nodes.find((entry) => isFluidTankRecipe(pasted.recipes.find((recipe) => recipe.id === entry.recipeId)));
    expect(tank).toBeDefined();
    expect(pasted.edges.map((edge) => [edge.resourceKind, edge.source === tank!.id || edge.target === tank!.id])).toEqual([
      ["item", true],
      ["fluid", true],
    ]);
  });
});
