import { isRecipeInputConsumed, makeResourceKey } from "../../model/resources";
import { applyRecipeInputOverrides } from "../../model/recipe-input-overrides";
import { applyMachineHandlerToRecipe } from "../../model/recipe-rules";
import { listNodeSections, sectionHandleId } from "../../model/shared-machine";
import { poolSideOf } from "../../model/storage-role";
import { hasStorageTarget, storageTargetMode } from "../../model/storage-target";
import { getRuntimeCalculationOutputs } from "../runtime-calculation";
import { listPoolCellPairs } from "../pool-mode";
import { convertLooseCellWires } from "../../model/cell-wires";
import type {
  FactoryEdge,
  FactoryProject,
  FactoryStorage,
  ResourceAmount,
  ResourceKey,
} from "../../model/types";

/** What turning a Pool plan into wires did, as counts and ids. */
export interface PoolConversionReport {
  /** Wires made (one per resource per pair of ends). */
  wires: number;
  /** Cell/fluid bridges made, each a fluid tank between its two ends. */
  bridgeWires: number;
  /** Drawers with a pool side that no wire could reach (nothing on the other side). */
  unreachedDrawers: number;
  /** Drawers joined into the first drawer of the same resource and side (a port holds one drawer); their ids. */
  duplicateDrawers: string[];
  /** Saved wires Pool was ignoring. */
  savedWiresDropped: number;
  /** Production groups dropped. */
  groups: number;
  /** Pool resource rules dropped. */
  rules: number;
}

interface End {
  node: string;
  /** Which recipe of a shared machine; two sections of one card are two machines. */
  section: number;
  handle: string;
  resource: Pick<ResourceAmount, "kind" | "id" | "displayName">;
  storage: boolean;
}

const sameMachine = (a: End, b: End) => a.node === b.node && a.section === b.section;

const handleOf = (side: "input" | "output", section: number, resource: Pick<ResourceAmount, "kind" | "id">) =>
  sectionHandleId(section, `${side}:${resource.kind}:${encodeURIComponent(resource.id)}`);

/**
 * A Pool plan as a wired one. Pool had no wires: every resource was one shared
 * pool all the cards and drawers drew from and fed. The plan board has wires
 * and gates, so each resource's pool becomes one wire per feeder and taker
 * pair (the wires a player would draw, none of them routed), and drawers keep
 * their side: a source drawer feeds every taker, a drain takes from every
 * feeder. Cell and fluid bridges (`poolCellRatios`) become fluid tanks.
 * Groups and resource rules have no counterpart and are dropped; everything
 * else (pins, drawer rules, counts) stays as the Solve plan it already was.
 *
 * Pure; returns the same Solve-shaped project (pool flag cleared, saved wires
 * replaced) for the Solve conversion to finish.
 */
export function wirePoolProject(project: FactoryProject): { project: FactoryProject; report: PoolConversionReport } {
  const report: PoolConversionReport = {
    wires: 0,
    bridgeWires: 0,
    unreachedDrawers: 0,
    duplicateDrawers: [],
    savedWiresDropped: project.edges.length,
    groups: project.productionGroups?.length ?? 0,
    rules: Object.keys(project.poolResourceRules ?? {}).length,
  };
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const feeders = new Map<ResourceKey, End[]>();
  const takers = new Map<ResourceKey, End[]>();
  const push = (map: Map<ResourceKey, End[]>, key: ResourceKey, end: End) => {
    const list = map.get(key);
    if (list) list.push(end);
    else map.set(key, [end]);
  };

  for (const node of project.nodes) {
    if (node.enabled === false) continue;
    for (const { section, node: view } of listNodeSections(node)) {
      const recipe = recipesById.get(view.recipeId);
      if (!recipe) continue;
      const contextual = applyRecipeInputOverrides(recipe, view);
      const effective = applyMachineHandlerToRecipe(contextual, view);
      const outputs = getRuntimeCalculationOutputs(effective, view) ?? effective.outputs;
      const seenIn = new Set<ResourceKey>();
      for (const input of contextual.inputs) {
        if (!isRecipeInputConsumed(input) || input.amount <= 0) continue;
        const key = makeResourceKey(input.kind, input.id);
        if (seenIn.has(key)) continue;
        seenIn.add(key);
        push(takers, key, { node: node.id, section, handle: handleOf("input", section, input), resource: input, storage: false });
      }
      const seenOut = new Set<ResourceKey>();
      for (const output of outputs) {
        if (output.amount <= 0) continue;
        const key = makeResourceKey(output.kind, output.id);
        if (seenOut.has(key)) continue;
        seenOut.add(key);
        push(feeders, key, { node: node.id, section, handle: handleOf("output", section, output), resource: output, storage: false });
      }
    }
  }

  // Drawers on a side of the pool. A resource's other drawers on the same
  // side join the first (rates added): a port holds one drawer on the plan board.
  const sideTaken = new Map<string, { storage: FactoryStorage; index: number }>();
  const keptStorages: FactoryStorage[] = [];
  const drawerEnds: Array<{ storage: FactoryStorage; side: "source" | "drain"; key: ResourceKey }> = [];
  const wiredIn = new Set(project.edges.map((edge) => edge.target));
  const wiredOut = new Set(project.edges.map((edge) => edge.source));
  for (const storage of project.storages ?? []) {
    const side = poolSideOf(storage, wiredIn.has(storage.id), wiredOut.has(storage.id));
    const { poolSide: _side, productionGroupId: _group, ...plain } = storage;
    void _side;
    void _group;
    if (!side) {
      keptStorages.push(plain);
      continue;
    }
    const key = makeResourceKey(storage.kind, storage.resourceId);
    const slot = `${side}|${key}`;
    const first = sideTaken.get(slot);
    if (first) {
      report.duplicateDrawers.push(storage.id);
      const role = side === "source" ? "source" : "product";
      const merged = joinRates(first.storage, storage, role, side === "source" ? "at-most" : "at-least");
      keptStorages[first.index] = merged;
      const end = drawerEnds.find((entry) => entry.storage === first.storage)!;
      end.storage = merged;
      sideTaken.set(slot, { storage: merged, index: first.index });
      continue;
    }
    sideTaken.set(slot, { storage: plain, index: keptStorages.length });
    keptStorages.push(plain);
    drawerEnds.push({ storage: plain, side, key });
  }

  const edges: FactoryEdge[] = [];
  const used = new Set<string>();
  const wire = (from: End, to: End, resource: Pick<ResourceAmount, "kind" | "id" | "displayName">, extra?: Partial<FactoryEdge>) => {
    const id = `pool-wire:${from.node}${from.section ? `#${from.section}` : ""}>${to.node}${to.section ? `#${to.section}` : ""}:${resource.kind}:${resource.id}${extra?.crossForm ? ":x" : ""}`;
    if (used.has(id)) return false;
    used.add(id);
    edges.push({
      id,
      source: from.node,
      target: to.node,
      sourceHandle: from.handle,
      targetHandle: to.handle,
      resourceKind: resource.kind,
      resourceId: resource.id,
      label: resource.displayName,
      ...extra,
    });
    return true;
  };

  for (const [key, outs] of feeders) {
    const ins = takers.get(key) ?? [];
    const power = key.startsWith("power:");
    for (const from of outs) {
      for (const to of ins) {
        // Electricity is a resource only drawers take; a generator never wires a machine.
        if (power || sameMachine(from, to)) continue;
        if (wire(from, to, from.resource)) report.wires += 1;
      }
    }
  }

  const reached = new Set<string>();
  for (const { storage, side, key } of drawerEnds) {
    const handleSide = (s: "input" | "output") => makeStorageHandle(s, storage);
    if (side === "source") {
      const resource = { kind: storage.kind, id: storage.resourceId, displayName: storage.displayName };
      const own: End = { node: storage.id, section: 0, handle: handleSide("output"), resource, storage: true };
      for (const to of takers.get(key) ?? []) {
        if (wire(own, to, resource)) {
          report.wires += 1;
          reached.add(storage.id);
        }
      }
    } else {
      const own: End = {
        node: storage.id,
        section: 0,
        handle: handleSide("input"),
        resource: { kind: storage.kind, id: storage.resourceId, displayName: storage.displayName },
        storage: true,
      };
      for (const from of feeders.get(key) ?? []) {
        if (wire(from, own, from.resource)) {
          report.wires += 1;
          reached.add(storage.id);
        }
      }
    }
  }
  report.unreachedDrawers = drawerEnds.filter(({ storage }) => !reached.has(storage.id)).length;

  // Cell and fluid bridges: one form into a port of the other, marked with the Canner's litres; the tank that
  // stands between the two is put in on the way out.
  for (const pair of listPoolCellPairs(project)) {
    const litres = project.poolCellRatios?.[pair.cellId];
    if (!litres || litres <= 0) continue;
    const cellKey = makeResourceKey("item", pair.cellId);
    const fluidKey = makeResourceKey("fluid", pair.fluidId);
    for (const from of feeders.get(cellKey) ?? []) {
      for (const to of takers.get(fluidKey) ?? []) {
        if (!sameMachine(from, to) && wire(from, to, from.resource, { crossForm: { litresPerCell: litres } })) {
          report.wires += 1;
          report.bridgeWires += 1;
        }
      }
    }
    for (const from of feeders.get(fluidKey) ?? []) {
      for (const to of takers.get(cellKey) ?? []) {
        if (!sameMachine(from, to) && wire(from, to, from.resource, { crossForm: { litresPerCell: litres } })) {
          report.wires += 1;
          report.bridgeWires += 1;
        }
      }
    }
  }

  const nodes = project.nodes.map((node) => {
    if (node.productionGroupId === undefined) return node;
    const { productionGroupId: _group, ...rest } = node;
    void _group;
    return rest;
  });
  const {
    poolMode: _pool,
    poolResourceRules: _rules,
    productionGroups: _groups,
    poolCellRatios: _ratios,
    ...rest
  } = project;
  void _pool;
  void _rules;
  void _groups;
  void _ratios;
  // A cell meets its fluid only in a fluid tank: each bridge gets one between its ends.
  return {
    project: convertLooseCellWires({ ...rest, solveMode: true, nodes, storages: keptStorages, edges }).project,
    report,
  };
}

/**
 * Two drawers of one resource on one side of the pool as one: their rates add
 * (each asked for its own share of the same pool). Rules that differ become
 * `otherwise`; a drawer with no rate adds nothing.
 */
function joinRates(
  into: FactoryStorage,
  other: FactoryStorage,
  role: "source" | "product",
  otherwise: "at-least" | "at-most",
): FactoryStorage {
  const asked = (storage: FactoryStorage) => {
    // Pool sides are already stripped here; put the role back for the reading.
    const probe = { ...storage, poolSide: role === "source" ? ("source" as const) : ("drain" as const) };
    return hasStorageTarget(probe, role)
      ? { rate: Math.abs(probe.targetPerSecond!), mode: storageTargetMode(probe, role) }
      : undefined;
  };
  const a = asked(into);
  const b = asked(other);
  if (!a && !b) return into;
  if (!b) return { ...into };
  if (!a) {
    return { ...into, targetPerSecond: b.rate, targetMode: b.mode };
  }
  return {
    ...into,
    targetPerSecond: a.rate + b.rate,
    targetMode: a.mode === b.mode ? a.mode : otherwise,
  };
}

function makeStorageHandle(side: "input" | "output", storage: Pick<FactoryStorage, "kind" | "resourceId">): string {
  return `${side}:${storage.kind}:${encodeURIComponent(storage.resourceId)}`;
}
