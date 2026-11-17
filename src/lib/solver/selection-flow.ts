import { expandPocketSelection } from "../model/pocket-connections";
import { makeResourceKey } from "../model/resources";
import { sectionOwnerId } from "../model/shared-machine";
import { getStorageRoles } from "../model/storage-role";
import type { FactoryProject, ResourceBalance, ResourceFlow, ResourceKey, ThroughputResult } from "../model/types";
import { selectInternalBalances } from "./balances";
import { closeBoundaries } from "./close-boundaries";
import { calculateThroughput } from "./throughput";

export function measureSelectionFlow(
  project: FactoryProject,
  result: ThroughputResult,
  itemIds: ReadonlySet<string>,
) {
  const groups = {
    inputs: new Map<ResourceKey, ResourceFlow>(),
    outputs: new Map<ResourceKey, ResourceFlow>(),
    internal: new Map<ResourceKey, ResourceFlow>(),
  };
  const add = (side: keyof typeof groups, resource: Omit<ResourceFlow, "amountPerSecond">, perSecond: number) => {
    if (!(perSecond > 0)) return;
    const rows = groups[side];
    const rate = (rows.get(resource.key)?.amountPerSecond ?? 0) + perSecond;
    rows.set(resource.key, { ...resource, amountPerSecond: rate });
  };
  for (const edge of project.edges) {
    const source = itemIds.has(edge.source);
    const target = itemIds.has(edge.target);
    if (!source && !target) continue;
    const solved = result.edges[edge.id];
    if (solved) {
      const side = source && target ? "internal" : target ? "inputs" : "outputs";
      add(side, solved.resource, solved.transferredPerSecond);
    }
  }
  // The plan also exchanges material through open or forced ports and through
  // drawers on its boundary. Those rates have no board wire of their own.
  for (const port of [...(result.plan?.terminals ?? []), ...(result.plan?.forced ?? [])]) {
    if (!itemIds.has(sectionOwnerId(port.nodeId))) continue;
    const balance = result.resources[port.resourceKey as ResourceKey];
    if (!balance) continue;
    const { key, kind, resourceId, displayName } = balance;
    add(port.side === "in" ? "inputs" : "outputs", { key, kind, resourceId, displayName }, port.perSecond);
  }
  const drawers = (project.storages ?? []).filter(({ id }) => itemIds.has(id));
  const roles = drawers.length ? getStorageRoles(project) : undefined;
  for (const drawer of drawers) {
    const flow = result.storages[drawer.id];
    if (!flow) continue;
    const { kind, resourceId, displayName } = flow;
    const resource = { key: makeResourceKey(kind, resourceId), kind, resourceId, displayName };
    switch (roles?.get(drawer.id)) {
      case "source":
        add("inputs", resource, flow.consumedPerSecond);
        break;
      case "product":
      case "byproduct":
        add("outputs", resource, flow.producedPerSecond);
        break;
      case "buffer":
        add("outputs", resource, flow.netPerSecond);
        break;
    }
  }
  return {
    inputs: [...groups.inputs.values()],
    outputs: [...groups.outputs.values()],
    internal: [...groups.internal.values()],
  };
}

/**
 * The Need/Output/Internal books for a subset of the board.
 *
 * Same three lists as a plan-wide result, same shapes, so the flow panel can
 * swap one for the other without knowing which it holds.
 */
export interface SelectionFlow {
  resources: Record<ResourceKey, ResourceBalance>;
  externalInputs: ResourceBalance[];
  unconsumedOutputs: ResourceBalance[];
  internal: ResourceBalance[];
  /** Machine cards counted, for the "scoped to N machines" strip. */
  machineCount: number;
  /** Drawers and tanks caught by the selection, counted the same way. */
  storageCount: number;
  /** The selection's own power draw, for the panel's EU-per-unit reading. */
  totalEuT: number;
}

/**
 * Solve the selection as if it were the whole board: these cards exist,
 * everything else is gone, and any wire with one foot outside is gone with it.
 * The severed wires are what make the panel interesting - a resource the plan
 * makes internally becomes a Need when only its consumer is selected, and an
 * Output when only its maker is.
 *
 * This is a real second solve, not a re-tally of the plan's numbers. A
 * machine the board throttles because its supplier is small runs at FULL
 * speed here once that supplier is outside the box, so the panel answers
 * "what would this chunk need to run properly", the same question a saved
 * blueprint answers (see `computeBlueprintIo`).
 *
 * Selecting a minimized board counts everything inside it. Returns undefined when
 * the selection holds no machine cards at all, which is the panel's signal to
 * keep showing the whole plan.
 */
export function calculateSelectionFlow(
  project: FactoryProject,
  selectedIds: readonly string[],
): SelectionFlow | undefined {
  if (selectedIds.length === 0) {
    return undefined;
  }

  const { itemIds } = expandPocketSelection(project, selectedIds);
  if (itemIds.size === 0) {
    return undefined;
  }

  const nodes = project.nodes.filter((node) => itemIds.has(node.id));
  // Drawers and notes carry no recipe, so a selection of nothing but those has
  // no flows to book. The plan is more useful there than an empty scope.
  if (nodes.length === 0) {
    return undefined;
  }
  const storages = (project.storages ?? []).filter((storage) => itemIds.has(storage.id));

  const scoped: FactoryProject = {
    ...project,
    nodes,
    storages,
    annotations: [],
    // Wires survive only with both feet inside, exactly as a copy or a
    // blueprint capture takes them.
    edges: project.edges.filter(
      (edge) => itemIds.has(edge.source) && itemIds.has(edge.target),
    ),
  };

  // Heal the cut before solving: every severed wire leaves a bare slot, and
  // in a closed plan a bare slot stops its machine, so any scoped solve
  // would answer zero. Closing the boundary puts a source on what arrives
  // from outside and a drain on what leaves; those read as this scope's
  // needs and outputs (see close-boundaries.ts).
  //
  // Not cloned: the solver only reads the project, and a selection re-solves
  // often enough that a deep copy of every selected card would show.
  const result = calculateThroughput(closeBoundaries(scoped), {
    generatedAt: "selection",
  });

  return {
    resources: result.resources,
    externalInputs: result.externalInputs,
    unconsumedOutputs: result.unconsumedOutputs,
    internal: selectInternalBalances(Object.values(result.resources)),
    machineCount: nodes.length,
    storageCount: storages.length,
    totalEuT: result.totalEuT,
  };
}
