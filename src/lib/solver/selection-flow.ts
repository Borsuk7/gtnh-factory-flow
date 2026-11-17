import { expandPocketSelection } from "../model/pocket-connections";
import { withPinRule } from "../model/pin-rule";
import type { FactoryProject, ResourceBalance, ResourceFlow, ResourceKey, ThroughputResult } from "../model/types";
import { selectInternalBalances } from "./balances";
import { closeBoundaries } from "./close-boundaries";
import { calculateThroughput } from "./throughput";

export function measureSelectionFlow(
  project: FactoryProject,
  result: ThroughputResult,
  selectedIds: readonly string[],
) {
  const { itemIds } = expandPocketSelection(project, selectedIds);
  const groups = {
    inputs: new Map<ResourceKey, ResourceFlow>(),
    outputs: new Map<ResourceKey, ResourceFlow>(),
    internal: new Map<ResourceKey, ResourceFlow>(),
  };
  for (const edge of project.edges) {
    const source = itemIds.has(edge.source);
    const target = itemIds.has(edge.target);
    if (!source && !target) continue;
    const solved = result.edges[edge.id];
    if (!solved || !(solved.transferredPerSecond > 0)) continue;
    const rows = source && target ? groups.internal : target ? groups.inputs : groups.outputs;
    const resource = solved.resource;
    const rate = (rows.get(resource.key)?.amountPerSecond ?? 0) + solved.transferredPerSecond;
    rows.set(resource.key, { ...resource, amountPerSecond: rate });
  }
  return {
    itemIds,
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
  unsized?: boolean;
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
  previewMachine?: { id: string; count: number },
): SelectionFlow | undefined {
  const scenario = prepareSelectionFlow(project, selectedIds, previewMachine);
  return scenario?.summarize(calculateThroughput(scenario.project, { generatedAt: "selection" }));
}

export function prepareSelectionFlow(
  project: FactoryProject,
  selectedIds: readonly string[],
  previewMachine?: { id: string; count: number },
) {
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
    nodes: previewMachine && project.planMode
      ? nodes.map((node) => node.id === previewMachine.id ? withPinRule(node, "exact", previewMachine.count) : node)
      : nodes,
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
  return {
    project: closeBoundaries(scoped),
    summarize: (result: ThroughputResult): SelectionFlow => ({
      resources: result.resources,
      externalInputs: result.externalInputs,
      unconsumedOutputs: result.unconsumedOutputs,
      internal: selectInternalBalances(Object.values(result.resources)),
      machineCount: nodes.length,
      storageCount: storages.length,
      totalEuT: result.totalEuT,
      unsized: result.plan?.failure?.message === "NO_PIN" || result.plan?.unanchored.some((id) => itemIds.has(id)),
    }),
  };
}
