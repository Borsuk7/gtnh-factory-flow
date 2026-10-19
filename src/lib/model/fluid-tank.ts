import type { FactoryNode, Recipe, ResourceAmount } from "./types";

/**
 * The fluid tank card (the mod's FluidTank): the dataset's Tank map made visible. A Tank recipe is a free, instant
 * converter between a filled cell (or bucket, capsule, can) and its fluid: emptying, the cell in and its fluid and
 * the empty container out; filling, the reverse. The litres a container holds are the dataset's own. A tank card
 * holds nothing until a port is dropped on it (it then takes the Tank recipe that port fits), and lets go when
 * nothing is wired to it (`releaseFluidTanks`), as the custom rate card does. It has no count: it keeps up with
 * whatever the plan needs.
 *
 * It is the only place a cell meets its fluid: no wire crosses forms, and an older plan's loose cell wires become tank
 * cards where the plan lands (`cell-wires.ts`).
 */
export const FLUID_TANK_MACHINE_TYPE = "Tank";
/** The dataset's own map, and the empty card's. */
export const FLUID_TANK_MAP = "Tank";
export const FLUID_TANK_EMPTY_MAP = "fluid-tank";
export const FLUID_TANK_NAME = "Fluid Tank";
export const FLUID_TANK_EMPTY_RECIPE_PREFIX = "fluid-tank:empty:";

export type FluidTankMode = "empty" | "fill";

export function isFluidTankRecipe(
  recipe:
    | (Pick<Recipe, "machineType"> & { source?: Pick<NonNullable<Recipe["source"]>, "recipeMap"> })
    | undefined,
): boolean {
  if (recipe?.machineType !== FLUID_TANK_MACHINE_TYPE) return false;
  const map = recipe.source?.recipeMap;
  return map === FLUID_TANK_MAP || map === FLUID_TANK_EMPTY_MAP;
}

/** The cell, the fluid it holds (amount: litres) and the container it leaves. */
export interface FluidTankPair {
  cell: ResourceAmount;
  fluid: ResourceAmount;
  empty: ResourceAmount;
}

export interface FluidTankSlot {
  mode: FluidTankMode;
  pair: FluidTankPair;
}

export function createFluidTankPlaceholderRecipe(id: string): Recipe {
  return {
    id,
    name: FLUID_TANK_NAME,
    kind: "custom",
    category: "fluid-tank",
    machineType: FLUID_TANK_MACHINE_TYPE,
    minimumTier: "NONE",
    durationTicks: 1,
    eut: 0,
    inputs: [],
    outputs: [],
    notes: "Wire a cell or a fluid to it and it empties cells or fills them, free and at once.",
    source: { recipeMap: FLUID_TANK_EMPTY_MAP },
  };
}

/** What the card holds, read off its recipe; undefined while it is empty. */
export function getFluidTankSlot(
  recipe: Pick<Recipe, "inputs" | "outputs">,
): FluidTankSlot | undefined {
  const fluidOut = recipe.outputs.find((slot) => slot.kind === "fluid");
  const itemsIn = recipe.inputs.filter((slot) => slot.kind === "item");
  const itemsOut = recipe.outputs.filter((slot) => slot.kind === "item");
  if (fluidOut && itemsIn.length === 1 && itemsOut.length === 1) {
    return { mode: "empty", pair: { cell: itemsIn[0]!, fluid: fluidOut, empty: itemsOut[0]! } };
  }
  const fluidIn = recipe.inputs.find((slot) => slot.kind === "fluid");
  if (fluidIn && itemsIn.length === 1 && itemsOut.length === 1) {
    return { mode: "fill", pair: { cell: itemsOut[0]!, fluid: fluidIn, empty: itemsIn[0]! } };
  }
  return undefined;
}

/** The empty card's recipe id for one node: stable, so releasing twice mints one. */
export function fluidTankEmptyRecipeId(nodeId: string): string {
  return `${FLUID_TANK_EMPTY_RECIPE_PREFIX}${nodeId}`;
}

/**
 * Every fluid tank card left holding a Tank recipe with nothing wired to it, emptied: the node goes back to its
 * own empty recipe. The same project when there is nothing to release.
 */
export function releaseFluidTanks<
  Project extends {
    nodes: FactoryNode[];
    recipes: Recipe[];
    edges: Array<{ source: string; target: string }>;
  },
>(project: Project): Project {
  const byId = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  let wired: Set<string> | undefined;
  let nodes: FactoryNode[] | undefined;
  let recipes: Recipe[] | undefined;
  project.nodes.forEach((node, index) => {
    const recipe = byId.get(node.recipeId);
    if (!isFluidTankRecipe(recipe) || !getFluidTankSlot(recipe!)) return;
    wired ??= new Set(project.edges.flatMap((edge) => [edge.source, edge.target]));
    if (wired.has(node.id)) return;
    const emptyId = fluidTankEmptyRecipeId(node.id);
    nodes ??= [...project.nodes];
    recipes ??= [...project.recipes];
    if (!byId.has(emptyId)) {
      const empty = createFluidTankPlaceholderRecipe(emptyId);
      recipes.push(empty);
      byId.set(emptyId, empty);
    }
    nodes[index] = { ...node, recipeId: emptyId };
  });
  return nodes ? { ...project, nodes, recipes: recipes ?? project.recipes } : project;
}

/**
 * Every fluid tank card's pin dropped. A tank has no count (it keeps up with the plan), so its card shows none and
 * cannot clear one: a pin on it (a Build plan's count, which conversion makes every card's pin) would force its crafts
 * through the plan with nothing shown as set, 20 cells a second for a count of 1 since a Tank craft is a tick. The
 * same project when no tank carries one.
 */
export function unpinFluidTanks<Project extends { nodes: FactoryNode[]; recipes: Recipe[] }>(
  project: Project,
): Project {
  if (!project.nodes.some((node) => node.solvePin !== undefined)) return project;
  const byId = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  let nodes: FactoryNode[] | undefined;
  project.nodes.forEach((node, index) => {
    if (node.solvePin === undefined || !isFluidTankRecipe(byId.get(node.recipeId))) return;
    const { solvePin: _pin, ...rest } = node;
    void _pin;
    nodes ??= [...project.nodes];
    nodes[index] = rest;
  });
  return nodes ? { ...project, nodes } : project;
}
