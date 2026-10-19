import { nearestFreeSpot, type PlacementRect } from "@/components/flow/board-placement";
import { BOARD_GRID, RECIPE_NODE_WIDTH, STORAGE_NODE_HEIGHT, STORAGE_NODE_WIDTH, snapPositionToGrid } from "@/lib/board-grid";
import { boardWindowSize } from "./board-windows";
import { FLUID_TANK_MACHINE_TYPE, FLUID_TANK_MAP } from "./fluid-tank";
import { sectionNodeView, splitSectionHandleId } from "./shared-machine";
import type {
  FactoryEdge,
  FactoryNode,
  FactoryPocket,
  FactoryStorage,
  Recipe,
  ResourceAmount,
  ResourceKind,
} from "./types";

/**
 * Cells and their fluids meet only in a fluid tank card, as in the mod. Plans from older builds may still carry
 * LOOSE CELL WIRES: a filled cell wired straight into its fluid's slot, or a fluid into its cell's, with the Canner's
 * litres a cell on `edge.crossForm`. Each one becomes a tank card between its two ends, holding the Tank recipe at
 * those litres, wired to both: the plan's numbers stay as they were (the tank is free and instant, as the hidden tank
 * the solver used to slip in was), and its empty cells show as the tank's own port.
 *
 * Runs where plans land (`normalizeLoadedProjectWithNotice`, a live plan's `applyLiveOps`, a paste) and nowhere else,
 * so the landing can say what changed. Pure and deterministic: the tank, its recipe and its wires take ids from the
 * wire they replace, so two screens converting one live plan write the same things.
 */

/** The dataset's plain empty cell: what nearly every cell a loose wire could take empties into. */
const EMPTY_CELL: Pick<ResourceAmount, "kind" | "id" | "displayName"> = {
  kind: "item",
  id: "ic2:itemcellempty",
  displayName: "Empty Cell",
};
/** A converted tank's recipe until the landing refresh finds the dataset's own by its slots. */
export const CELL_WIRE_TANK_RECIPE_PREFIX = "fluid-tank:cell-wire:";
/** The tank card a wire became: `cell-tank:<wire id>`. */
const TANK_NODE_PREFIX = "cell-tank:";
const TANK_HEIGHT = BOARD_GRID * 14;

interface PlanParts {
  nodes: FactoryNode[];
  storages?: FactoryStorage[];
  edges: FactoryEdge[];
  recipes: Recipe[];
  pockets?: FactoryPocket[];
  checklist?: { cards: string[]; edges: string[] };
}

export function hasLooseCellWires(project: Pick<PlanParts, "edges">): boolean {
  return project.edges.some((edge) => edge.crossForm !== undefined);
}

/** Every loose cell wire as a tank card between its ends. The same object when there is none. */
export function convertLooseCellWires<Plan extends PlanParts>(project: Plan): { project: Plan; converted: number } {
  if (!hasLooseCellWires(project)) {
    return { project, converted: 0 };
  }
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const nodesById = new Map(project.nodes.map((node) => [node.id, node] as const));
  const storagesById = new Map((project.storages ?? []).map((storage) => [storage.id, storage] as const));
  const takenIds = new Set([...nodesById.keys(), ...storagesById.keys()]);
  const edgeIds = new Set(project.edges.map((edge) => edge.id));
  const emptyCell = emptyCellFace(project.recipes);

  const nodes = [...project.nodes];
  const recipes = [...project.recipes];
  const edges: FactoryEdge[] = [];
  const placed: Array<{ home: string | undefined; rect: PlacementRect }> = [];
  const checked = new Set(project.checklist?.edges ?? []);
  const checkedAdd: string[] = [];
  let converted = 0;

  for (const edge of project.edges) {
    if (edge.crossForm === undefined) {
      edges.push(edge);
      continue;
    }
    const perCell = edge.crossForm.litresPerCell;
    const { crossForm: _litres, ...plain } = edge;
    void _litres;
    const far = parseHandle(edge.targetHandle);
    const sameKind = far !== undefined && far.kind === edge.resourceKind;
    if (sameKind) {
      // Not a crossing at all: an ordinary wire wearing the mark. The load funnel judges it like any other.
      edges.push(plain);
      continue;
    }
    const sourceEnd = endOf(edge.source, nodesById, storagesById);
    const targetEnd = endOf(edge.target, nodesById, storagesById);
    const crossing =
      far?.side === "input" &&
      ((edge.resourceKind === "item" && far.kind === "fluid") ||
        (edge.resourceKind === "fluid" && far.kind === "item"));
    if (!crossing || !sourceEnd || !targetEnd || !Number.isFinite(perCell) || !(perCell > 0)) {
      // Nothing a tank could stand between: the wire goes, and the slot reads short as any unwired one.
      continue;
    }
    const emptying = edge.resourceKind === "item";
    const cellId = emptying ? edge.resourceId : far.resourceId;
    const fluidId = emptying ? far.resourceId : edge.resourceId;
    const sourceFace = faceAt(edge.source, edge.sourceHandle, "output", edge.resourceKind, edge.resourceId, nodesById, storagesById, recipesById);
    const targetFace = faceAt(edge.target, edge.targetHandle, "input", far.kind, far.resourceId, nodesById, storagesById, recipesById);
    const cellFace = emptying ? { ...sourceFace, displayName: sourceFace.displayName ?? edge.label } : targetFace;
    const fluidFace = emptying ? targetFace : { ...sourceFace, displayName: sourceFace.displayName ?? edge.label };

    const recipeId = `${CELL_WIRE_TANK_RECIPE_PREFIX}${emptying ? "empty" : "fill"}:${encodeURIComponent(cellId)}:${encodeURIComponent(fluidId)}:${perCell}`;
    if (!recipesById.has(recipeId)) {
      const recipe = tankRecipe(
        recipeId,
        emptying,
        { kind: "item", id: cellId, amount: 1, ...cellFace },
        { kind: "fluid", id: fluidId, amount: perCell, ...fluidFace },
        { kind: EMPTY_CELL.kind, id: EMPTY_CELL.id, amount: 1, ...emptyCell },
      );
      recipes.push(recipe);
      recipesById.set(recipeId, recipe);
    }

    let tankId = `${TANK_NODE_PREFIX}${edge.id}`;
    for (let n = 2; takenIds.has(tankId); n += 1) tankId = `${TANK_NODE_PREFIX}${edge.id}:${n}`;
    takenIds.add(tankId);
    const home = targetEnd.pocketId;
    const position = placeTank(project, home, sourceEnd, targetEnd, placed);
    placed.push({ home, rect: { ...position, width: RECIPE_NODE_WIDTH, height: TANK_HEIGHT } });
    const tank: FactoryNode = {
      id: tankId,
      recipeId,
      machineCount: 1,
      parallel: 1,
      overclockTier: "NONE",
      enabled: true,
      position,
      ...(home !== undefined ? { pocketId: home } : {}),
    };
    nodes.push(tank);

    const wireKind = edge.resourceKind;
    const farKind: ResourceKind = far.kind;
    const { waypoints: _route, ratioInputWeight, ...rest } = plain;
    void _route;
    // The wire the player drew still leaves its port with its own resource; it now ends at the tank.
    edges.push({
      ...rest,
      target: tankId,
      targetHandle: handleOf("input", wireKind, edge.resourceId),
    });
    let outId = `${edge.id}:tank`;
    for (let n = 2; edgeIds.has(outId); n += 1) outId = `${edge.id}:tank:${n}`;
    edgeIds.add(outId);
    edges.push({
      id: outId,
      source: tankId,
      target: edge.target,
      sourceHandle: handleOf("output", farKind, far.resourceId),
      targetHandle: edge.targetHandle,
      resourceKind: farKind,
      resourceId: far.resourceId,
      ...(targetFace.displayName ? { label: targetFace.displayName } : {}),
      ...(ratioInputWeight !== undefined ? { ratioInputWeight } : {}),
    });
    if (checked.has(edge.id)) checkedAdd.push(outId);
    converted += 1;
  }

  const checklist =
    checkedAdd.length > 0 && project.checklist
      ? { ...project.checklist, edges: [...project.checklist.edges, ...checkedAdd] }
      : project.checklist;
  return {
    project: { ...project, nodes, recipes, edges, ...(checklist ? { checklist } : {}) },
    converted,
  };
}

/**
 * The Tank recipe as the dataset writes it (`planner.tank`): free, a tick a craft, the real slots. The landing
 * refresh swaps it for the dataset's own by its slots, which the server looks up by the first output: an emptying
 * tank names its fluid first, as over a thousand Tank recipes make the plain empty cell.
 */
function tankRecipe(
  id: string,
  emptying: boolean,
  cell: ResourceAmount,
  fluid: ResourceAmount,
  empty: ResourceAmount,
): Recipe {
  const outputs = emptying ? [fluid, empty] : [cell];
  const named = emptying ? empty : cell;
  return {
    id,
    name: `Tank: ${named.displayName ?? named.id}`,
    kind: "gregtech_machine",
    category: "gregtech",
    machineType: FLUID_TANK_MACHINE_TYPE,
    minimumTier: "NONE",
    durationTicks: 1,
    eut: 0,
    inputs: emptying ? [cell] : [empty, fluid],
    outputs,
    specialValue: 0,
    notes: "A free, instant canner: the planner's tank.",
    source: { recipeMap: FLUID_TANK_MAP, rawRecipeId: `planner.tank:${id.slice(CELL_WIRE_TANK_RECIPE_PREFIX.length)}` },
    metadata: { recipeMapId: "planner.tank", specialValue: 0 },
  };
}

type Face = Pick<ResourceAmount, "displayName" | "iconPath" | "iconAtlas" | "dominantColor" | "modId">;

function faceOf(slot: Partial<ResourceAmount> | undefined): Face {
  if (!slot) return {};
  const face: Face = {};
  if (slot.displayName) face.displayName = slot.displayName;
  if (slot.iconPath) face.iconPath = slot.iconPath;
  if (slot.iconAtlas) face.iconAtlas = slot.iconAtlas;
  if (slot.dominantColor) face.dominantColor = slot.dominantColor;
  if (slot.modId) face.modId = slot.modId;
  return face;
}

/** How a wire's end draws the resource: the slot it plugs into, or the drawer holding it. */
function faceAt(
  id: string,
  handle: string | undefined,
  side: "input" | "output",
  kind: ResourceKind,
  resourceId: string,
  nodesById: ReadonlyMap<string, FactoryNode>,
  storagesById: ReadonlyMap<string, FactoryStorage>,
  recipesById: ReadonlyMap<string, Recipe>,
): Face {
  const storage = storagesById.get(id);
  if (storage) return storage.kind === kind && storage.resourceId === resourceId ? faceOf(storage) : {};
  const card = nodesById.get(id);
  if (!card) return {};
  const node = sectionNodeView(card, splitSectionHandleId(handle).section);
  const recipe = recipesById.get(node.recipeId);
  const slots =
    side === "output"
      ? (recipe?.outputs ?? [])
      : [...Object.values(node.recipeInputOverrides ?? {}), ...(recipe?.inputs ?? [])];
  return faceOf(slots.find((slot) => slot?.kind === kind && slot.id === resourceId));
}

function emptyCellFace(recipes: readonly Recipe[]): Face {
  for (const recipe of recipes) {
    for (const slot of [...recipe.inputs, ...recipe.outputs]) {
      if (slot.kind === EMPTY_CELL.kind && slot.id === EMPTY_CELL.id) {
        return { displayName: EMPTY_CELL.displayName, ...faceOf(slot) };
      }
    }
  }
  return { displayName: EMPTY_CELL.displayName };
}

function parseHandle(
  handle: string | undefined,
): { side: string; kind: ResourceKind; resourceId: string } | undefined {
  const bare = splitSectionHandleId(handle).handleId;
  const [side, kind, encoded] = (bare ?? "").split(":");
  if (!side || (kind !== "item" && kind !== "fluid") || !encoded) return undefined;
  try {
    return { side, kind, resourceId: decodeURIComponent(encoded) };
  } catch {
    return undefined;
  }
}

function handleOf(side: "input" | "output", kind: ResourceKind, resourceId: string): string {
  return `${side}:${kind}:${encodeURIComponent(resourceId)}`;
}

interface End {
  position: { x: number; y: number };
  pocketId?: string;
  width: number;
  height: number;
}

function endOf(
  id: string,
  nodesById: ReadonlyMap<string, FactoryNode>,
  storagesById: ReadonlyMap<string, FactoryStorage>,
): End | undefined {
  const node = nodesById.get(id);
  if (node) return { position: node.position, pocketId: node.pocketId, width: RECIPE_NODE_WIDTH, height: TANK_HEIGHT };
  const storage = storagesById.get(id);
  if (storage) {
    return { position: storage.position, pocketId: storage.pocketId, width: STORAGE_NODE_WIDTH, height: STORAGE_NODE_HEIGHT };
  }
  return undefined;
}

/**
 * Where the tank goes: on the board of the card it feeds, between its two ends when they share that board (else
 * beside the fed end, upstream side), moved to the nearest spot clear of everything on that board.
 */
function placeTank(
  project: PlanParts,
  home: string | undefined,
  source: End,
  target: End,
  placed: ReadonlyArray<{ home: string | undefined; rect: PlacementRect }>,
): { x: number; y: number } {
  const desired = snapPositionToGrid(
    source.pocketId === home
      ? {
          x: (source.position.x + source.width / 2 + target.position.x + target.width / 2) / 2 - RECIPE_NODE_WIDTH / 2,
          y: (source.position.y + target.position.y) / 2,
        }
      : { x: target.position.x - RECIPE_NODE_WIDTH - BOARD_GRID * 3, y: target.position.y },
  );
  const blockers: PlacementRect[] = [];
  for (const node of project.nodes) {
    if (node.pocketId === home) blockers.push({ ...node.position, width: RECIPE_NODE_WIDTH, height: TANK_HEIGHT });
  }
  for (const storage of project.storages ?? []) {
    if (storage.pocketId === home) {
      blockers.push({ ...storage.position, width: STORAGE_NODE_WIDTH, height: STORAGE_NODE_HEIGHT });
    }
  }
  for (const pocket of project.pockets ?? []) {
    if (pocket.parentPocketId === home) {
      const size = pocket.expanded ? boardWindowSize(pocket) : { width: RECIPE_NODE_WIDTH, height: TANK_HEIGHT };
      blockers.push({ ...pocket.position, ...size });
    }
  }
  for (const entry of placed) {
    if (entry.home === home) blockers.push(entry.rect);
  }
  return snapPositionToGrid(
    nearestFreeSpot({ ...desired, width: RECIPE_NODE_WIDTH, height: TANK_HEIGHT }, blockers, BOARD_GRID),
  );
}
