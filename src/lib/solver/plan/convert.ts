import { isCustomRateRecipe } from "../../model/custom-rate";
import { dedupeEdgeWires } from "../../model/edge-identity";
import { isFluidTankRecipe } from "../../model/fluid-tank";
import { resourceMatchesInput } from "../../model/resources";
import { sectionHandleId } from "../../model/shared-machine";
import { getStorageRoles } from "../../model/storage-role";
import { keepsBuffer } from "./adapter/buffers";
import { hasStorageTarget } from "../../model/storage-target";
import type {
  FactoryEdge,
  FactoryNode,
  FactoryProject,
  FactoryStorage,
  Recipe,
  TargetRate,
} from "../../model/types";

/**
 * What the conversion did, for the notice a player may be shown. Counts and
 * ids only, never prose.
 */
export interface PlanConversionReport {
  /** Cards whose built count became a pin. */
  pinned: number;
  /** Port rates made from card targets and the plan's target. */
  portRates: number;
  /** Buffer drawers replaced by direct wires. */
  buffersExpanded: number;
  /** Ratio buffers, joined or kept (their shares are gone either way). */
  ratioBuffersFlattened: number;
  /** Drawers whose stored rate was set to Ignore (Build keeps rates dormant). */
  drawerRatesParked: number;
  /** Ids of targets (card or plan) that name a resource no card makes. */
  droppedTargets: string[];
  /**
   * A Solve plan that nothing anchored (no pin, no drawer rate, no port rate) would have opened at zero everywhere,
   * so its card targets and plan target became port rates (counted in `portRates`).
   */
  seededFromTargets: boolean;
  /** A Solve plan that is still unanchored after that: nothing to calculate until a count or rate is set. */
  unanchored: boolean;
}

export interface PlanConversion {
  project: FactoryProject;
  report: PlanConversionReport;
}

/**
 * A Build (or classic Solve) project as the plan board runs it. Pure: the
 * input is never mutated, the stored project stays Build-shaped, and a
 * project already in plan mode comes back as the same object.
 *
 * The same rules as the mod's importer of website plans (FfConverter):
 * - Build runs every card at its count, so each enabled card's `machineCount`
 *   becomes its pin (`solvePin`), an Up to pin (never `solvePinExact`: it is what the
 *   built machines can do, not a demand). A classic Solve project keeps the pins it
 *   has, which read as Up to as well.
 * - Card and plan targets were display arithmetic, never rows, so they stay
 *   as they are and pin nothing. Only a classic Solve plan that nothing else
 *   anchors turns them into port rates (its card's `targetOutput` on its output
 *   row, the plan's `targetRate` on the first card making the resource), as
 *   old Solve had no other answer there.
 * - A buffer drawer wired only to cards stays a buffer drawer (its rate, which
 *   no older board enforced, parked as no rule). Any other buffer (wired to a
 *   drawer, or by a loose cell wire) is joined: each wire into it to each wire
 *   out of it, one buffer at a time so a chain still joins its ends. Ratio
 *   buffers are plain buffers here: their shares are dropped.
 * - Build keeps drawer rates dormant, so a rate on a source or product drawer
 *   of a Build plan comes over as Ignore (the number stays, no rule). A
 *   classic Solve plan's rates were live and stay live.
 * - A custom rate card is pinned at its dial (count 1 unless it has a count).
 * - A fluid tank card is never pinned: it has no count.
 * - Pool mode is dropped (plan mode excludes it); groups stay stored, unread.
 */
export function convertBuildToPlanWithReport(project: FactoryProject): PlanConversion {
  const report: PlanConversionReport = {
    pinned: 0,
    portRates: 0,
    buffersExpanded: 0,
    ratioBuffersFlattened: 0,
    drawerRatesParked: 0,
    droppedTargets: [],
    seededFromTargets: false,
    unanchored: false,
  };
  if (project.planMode) {
    return { project, report };
  }

  const build = !project.solveMode;
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));

  const { edges, storages } = expandBuffers(project, report);

  let nodes = project.nodes.map((node) => {
    const recipe = recipesById.get(node.recipeId);
    if (!recipe || !node.enabled) {
      return node;
    }
    return pinNode(node, recipe, build, report);
  });
  // A card's target was display arithmetic in both Build and Solve: never a row. Build's counts are Up to now, so a
  // target made a port rate would pin its card exactly and the plan would no longer read as it did (docs/up-to.md).
  const parkedStorages = build ? parkDormantRates(storages, edges, project, report) : storages;
  if (!build && !hasLiveAnchor(nodes, parkedStorages, edges, project)) {
    // The old Solve had no unique answer here (every machine zero), so the targets the plan states stand in for it.
    nodes = applyTargets(project, nodes, recipesById, report);
    report.seededFromTargets = report.portRates > 0;
    report.unanchored = !report.seededFromTargets;
  }

  return {
    project: {
      ...project,
      nodes,
      edges,
      storages: parkedStorages,
      planMode: true,
      solveMode: true,
      poolMode: undefined,
    },
    report,
  };
}

export function convertBuildToPlan(project: FactoryProject): FactoryProject {
  return convertBuildToPlanWithReport(project).project;
}

/** Whether anything in a converted Solve plan sets a count or a rate: a pin, a port rate or a drawer rule. */
function hasLiveAnchor(
  nodes: FactoryNode[],
  storages: FactoryStorage[],
  edges: FactoryEdge[],
  project: FactoryProject,
): boolean {
  if (nodes.some((node) => node.enabled && ((node.solvePin ?? 0) > 0 || Object.keys(node.portRates ?? {}).length > 0))) {
    return true;
  }
  const roles = getStorageRoles({ ...project, storages, edges, poolMode: undefined });
  return storages.some((storage) => hasStorageTarget(storage, roles.get(storage.id)));
}

function pinNode(
  node: FactoryNode,
  recipe: Recipe,
  build: boolean,
  report: PlanConversionReport,
): FactoryNode {
  if (build) {
    // A fluid tank has no count: it keeps up with the plan, so it is never pinned.
    if (!(node.machineCount > 0) || isFluidTankRecipe(recipe)) {
      return node;
    }
    report.pinned += 1;
    return { ...node, solvePin: node.machineCount };
  }
  // Classic Solve: pins stay as they are, except that a custom rate card is
  // its dial, so it is pinned.
  if (isCustomRateRecipe(recipe) && !((node.solvePin ?? 0) > 0)) {
    report.pinned += 1;
    return { ...node, solvePin: node.machineCount > 0 ? node.machineCount : 1 };
  }
  return node;
}

/** The output handle of the row a target names, as `makeResourceHandleId` builds it. */
function outputHandleFor(
  recipe: Recipe | undefined,
  target: Pick<TargetRate, "kind" | "resourceId">,
): string | undefined {
  const output = recipe?.outputs.find((candidate) =>
    resourceMatchesInput({ kind: target.kind, id: target.resourceId }, candidate),
  );
  return output ? `output:${output.kind}:${encodeURIComponent(output.id)}` : undefined;
}

function applyTargets(
  project: FactoryProject,
  nodes: FactoryNode[],
  recipesById: Map<string, Recipe>,
  report: PlanConversionReport,
): FactoryNode[] {
  const result = [...nodes];
  const setRate = (index: number, handle: string, perSecond: number): boolean => {
    const node = result[index]!;
    if (node.portRates?.[handle] !== undefined || !(perSecond > 0) || !Number.isFinite(perSecond)) {
      return false;
    }
    result[index] = { ...node, portRates: { ...node.portRates, [handle]: perSecond } };
    report.portRates += 1;
    return true;
  };

  // Each card's own target, on its own recipe (section 0).
  result.forEach((node, index) => {
    const target = node.targetOutput;
    if (!target || !node.enabled) {
      return;
    }
    const handle = outputHandleFor(recipesById.get(node.recipeId), target);
    if (!handle) {
      report.droppedTargets.push(node.id);
      return;
    }
    setRate(index, handle, target.amountPerSecond);
  });

  // The plan's own target lands on the first card making it, unless a card
  // already targets that resource.
  const plan = project.targetRate;
  if (!plan) {
    return result;
  }
  const claimed = project.nodes.some(
    (node) =>
      node.enabled &&
      node.targetOutput &&
      node.targetOutput.kind === plan.kind &&
      node.targetOutput.resourceId === plan.resourceId,
  );
  if (claimed) {
    return result;
  }
  for (let index = 0; index < result.length; index += 1) {
    const node = result[index]!;
    if (!node.enabled) {
      continue;
    }
    const recipeIds = [node.recipeId, ...(node.extraRecipes ?? []).map((s) => s.recipeId)];
    for (let section = 0; section < recipeIds.length; section += 1) {
      const handle = outputHandleFor(recipesById.get(recipeIds[section]!), plan);
      if (handle && setRate(index, sectionHandleId(section, handle), plan.amountPerSecond)) {
        return result;
      }
    }
  }
  report.droppedTargets.push("plan");
  return result;
}

function expandBuffers(
  project: FactoryProject,
  report: PlanConversionReport,
): { edges: FactoryEdge[]; storages: FactoryStorage[] } {
  const roles = getStorageRoles({ ...project, poolMode: undefined });
  let edges = project.edges.map(stripRatio);
  const removed = new Set<string>();
  const storageIds = new Set((project.storages ?? []).map((storage) => storage.id));
  // A buffer wired only to cards stays a buffer drawer (`docs/buffer-drawers.md`); a ratio one loses its shares. No
  // older board enforced a buffer's rate, so a number on one comes over as no rule (the number stays).
  const storages = (project.storages ?? []).map((storage) => {
    if (roles.get(storage.id) !== "buffer" || !keepsBuffer(storage.id, project.edges, storageIds)) return storage;
    let kept: FactoryStorage = storage;
    if (storage.bufferMode !== undefined || storage.ratioExportPercent !== undefined) {
      if (storage.bufferMode === "ratio") report.ratioBuffersFlattened += 1;
      const { bufferMode: _mode, ratioExportPercent: _share, ...plain } = storage;
      void _mode;
      void _share;
      kept = plain;
    }
    if (hasStorageTarget(kept, "product")) {
      report.drawerRatesParked += 1;
      kept = { ...kept, targetMode: "ignore" };
    }
    return kept;
  });

  for (const storage of storages) {
    if (roles.get(storage.id) !== "buffer" || keepsBuffer(storage.id, project.edges, storageIds)) {
      continue;
    }
    const feeders = edges.filter((e) => e.target === storage.id && e.source !== storage.id);
    const takers = edges.filter((e) => e.source === storage.id && e.target !== storage.id);
    edges = edges.filter((e) => e.source !== storage.id && e.target !== storage.id);
    for (const feeder of feeders) {
      for (const taker of takers) {
        // A feeder or taker that is itself a drawer being expanded later keeps
        // its end; the join is re-made when that drawer's turn comes.
        const joined: FactoryEdge = {
          id: `${feeder.id}>${taker.id}`,
          source: feeder.source,
          target: taker.target,
          sourceHandle: feeder.sourceHandle,
          targetHandle: taker.targetHandle,
          resourceKind: feeder.resourceKind,
          resourceId: feeder.resourceId,
        };
        edges.push(joined);
      }
    }
    removed.add(storage.id);
    report.buffersExpanded += 1;
    if (storage.bufferMode === "ratio") {
      report.ratioBuffersFlattened += 1;
    }
  }

  return {
    edges: removed.size > 0 ? dedupeEdgeWires(edges) : edges,
    storages: storages.filter((storage) => !removed.has(storage.id)),
  };
}

function stripRatio(edge: FactoryEdge): FactoryEdge {
  if (edge.ratioWeight === undefined && edge.ratioInputWeight === undefined) {
    return edge;
  }
  const { ratioWeight: _weight, ratioInputWeight: _input, ...plain } = edge;
  void _weight;
  void _input;
  return plain;
}

/** Build never enforced a drawer's rate; keep the number, drop the rule. */
function parkDormantRates(
  storages: FactoryStorage[],
  edges: FactoryEdge[],
  project: FactoryProject,
  report: PlanConversionReport,
): FactoryStorage[] {
  const roles = getStorageRoles({ ...project, storages, edges, poolMode: undefined });
  return storages.map((storage) => {
    const role = roles.get(storage.id);
    if ((role !== "source" && role !== "product") || !hasStorageTarget(storage, role)) {
      return storage;
    }
    report.drawerRatesParked += 1;
    return { ...storage, targetMode: "ignore" as const };
  });
}

/**
 * A clipboard or blueprint as the plan board takes it. What was copied on an
 * older board may hold buffer drawers, ratio shares, pool sides and
 * production groups; only plain buffers exist in plan mode, so a buffer is
 * kept as one or joined into the wires it stood for (as `convertBuildToPlan`
 * does) and the rest is dropped. Counts are not pinned: a pasted card is free, like any new card.
 */
export function planClipboard<
  T extends {
    nodes: FactoryNode[];
    storages: FactoryStorage[];
    edges: FactoryEdge[];
    productionGroups?: unknown[];
  },
>(payload: T): T {
  const scratch = {
    nodes: payload.nodes,
    storages: payload.storages,
    edges: payload.edges,
    recipes: [],
  } as unknown as FactoryProject;
  const report: PlanConversionReport = {
    pinned: 0,
    portRates: 0,
    buffersExpanded: 0,
    ratioBuffersFlattened: 0,
    drawerRatesParked: 0,
    droppedTargets: [],
    seededFromTargets: false,
    unanchored: false,
  };
  const expanded = payload.storages.length > 0 ? expandBuffers(scratch, report) : undefined;
  const storages = (expanded?.storages ?? payload.storages).map((storage) => {
    const { poolSide: _side, productionGroupId: _group, ...rest } = storage;
    void _side;
    void _group;
    return rest;
  });
  const nodes = payload.nodes.map((node) => {
    if (node.productionGroupId === undefined) return node;
    const { productionGroupId: _group, ...rest } = node;
    void _group;
    return rest;
  });
  const edges = expanded?.edges ?? payload.edges.map(stripRatio);
  return { ...payload, nodes, storages, edges, productionGroups: undefined };
}
