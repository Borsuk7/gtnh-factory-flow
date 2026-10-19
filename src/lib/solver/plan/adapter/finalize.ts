import { makeResourceKey } from "../../../model/resources";
import type {
  EdgeThroughput,
  NodeThroughputResult,
  ResourceBalance,
  ResourceKey,
  ThroughputResult,
} from "../../../model/types";
import { TICKS_PER_SECOND } from "../../../model/types";
import { calculateEffectiveBalances, splitBalances } from "../../balances";
import type { PlanSolveArgs } from "./args";
import type { PlanUpTo } from "../types";
import type { PlanReading } from "./answer";
import type { PlanModel } from "./model";

const EPSILON = 0.000001;

/** An Up to card's status: its read-out's bottleneck, or below its count, else balanced. */
function upToStatus(upTo: PlanUpTo, level: number): NodeThroughputResult["status"] {
  if (upTo.reason === "BOTTLENECK") return "bottleneck";
  if (level < 1 - EPSILON) return "underutilized";
  return "balanced";
}

/**
 * The plan-mode result: every machine report rewritten AT THE SOLVED SCALE
 * (as `finalizeSolveModeResult` does), so every downstream book reads true
 * figures without knowing the mode exists. The count answer rides
 * `theoreticalMachinesRequired`. `ThroughputResult.plan` carries what only
 * this mode has.
 */
export function finalizePlanResult(
  args: PlanSolveArgs,
  model: PlanModel,
  reading: PlanReading,
): ThroughputResult {
  const { project, nodes, storages, projectStorages, bottlenecks, options } = args;
  const helpers = args.helpers;
  if (!helpers) {
    throw new Error("Plan mode: the seam did not hand over the books' helpers.");
  }

  let totalEuT = 0;
  for (const nodeResult of Object.values(nodes) as NodeThroughputResult[]) {
    if (!nodeResult.enabled || nodeResult.status === "missing-recipe") {
      continue;
    }
    const entry = model.machines.get(nodeResult.nodeId);
    const count = reading.counts.get(nodeResult.nodeId) ?? 0;
    const built = entry?.builtCount ?? 0;
    const upTo = reading.extras.upTo?.[nodeResult.nodeId];
    // A shared card's read-out is its whole pool, filed under section 0's id: each recipe keeps its own solved count
    // (the section shares and the machine list add them up), and only a single card takes what it reached.
    const shared = (model.groups.get(entry?.owner ?? nodeResult.nodeId)?.length ?? 0) > 1;
    nodeResult.theoreticalMachinesRequired = upTo && !shared ? upTo.reached : count;
    nodeResult.disposalUtilization = 1;
    // Flows are nameplate at the built count; the solved scale is count / built.
    const act = built > 0 ? count / built : 0;
    if (count <= EPSILON || !(act > 0)) {
      // A machine nothing needs keeps its NAMEPLATE rates: port rows and
      // handles are built from them. Utilization 0 says nothing runs.
      nodeResult.utilization = 0;
      nodeResult.capableUtilization = 0;
      nodeResult.demandUtilization = 0;
      nodeResult.requiredRatePerSecond = 0;
      nodeResult.status = "underutilized";
      continue;
    }
    nodeResult.operationRatePerSecond *= act;
    for (const flow of Object.values(nodeResult.inputs)) {
      flow.amountPerSecond *= act;
    }
    for (const flow of Object.values(nodeResult.outputs)) {
      flow.amountPerSecond *= act;
    }
    nodeResult.euT *= act;
    totalEuT += nodeResult.euT;
    // Every flow above is already the solved one, so a running card is fully used at its solved count: every reader
    // that scales a flow by utilization (the overview, port rows, wires, a group's summary) would count an Up to
    // card's level twice. How full an Up to card is of its count is its read-out's (reached over capacity).
    const level = upTo && upTo.capacity > 0 ? Math.min(1, upTo.reached / upTo.capacity) : 1;
    nodeResult.utilization = 1;
    nodeResult.capableUtilization = 1;
    nodeResult.demandUtilization = 1;
    const primary = Object.values(nodeResult.outputs)[0];
    nodeResult.requiredRatePerSecond = primary?.amountPerSecond ?? 0;
    nodeResult.maxRatePerSecond = primary?.amountPerSecond ?? 0;
    nodeResult.status = upTo ? upToStatus(upTo, level) : "balanced";
  }

  // EVERY edge gets a result: a missing entry is how wires vanish.
  const edgeResults: Record<string, EdgeThroughput> = {};
  for (const edge of project.edges) {
    const flow = reading.edgeFlows.get(edge.id) ?? 0;
    edgeResults[edge.id] = helpers.buildEdgeResult(
      edge,
      makeResourceKey(edge.resourceKind, edge.resourceId),
      flow,
      flow,
    );
  }
  helpers.refreshStorageResultsFromEdges(projectStorages, storages, project.edges, edgeResults);

  const unmet = new Set(reading.extras.unmetDrawers ?? []);
  for (const storage of projectStorages) {
    const result = storages[storage.id];
    const role = model.roles.get(storage.id);
    if (!result || (role !== "product" && role !== "source")) {
      continue;
    }
    result.targetPerSecond = storage.targetPerSecond;
    if (unmet.has(storage.id)) {
      result.targetUnreachable = true;
      bottlenecks.push({
        id: `solve-target:${storage.id}`,
        kind: "resource-deficit",
        severity: "critical",
        message: `${storage.displayName ?? storage.resourceId}: the plan cannot ${role === "source" ? "use" : "make"} ${Math.abs(storage.targetPerSecond ?? 0).toFixed(2)}/s at these settings.`,
      });
    }
  }
  const failure = reading.extras.failure;
  if (failure && failure.message !== "NO_PIN") {
    bottlenecks.push({
      id: "plan-failed",
      kind: "resource-deficit",
      severity: "critical",
      message: "The plan could not be solved.",
    });
  }

  const resourceResults = Object.fromEntries(
    calculateEffectiveBalances(project, nodes, edgeResults),
  ) as Record<ResourceKey, ResourceBalance>;
  const { externalInputs, unconsumedOutputs } = splitBalances(Object.values(resourceResults));

  return {
    nodes,
    storages,
    resources: resourceResults,
    edges: edgeResults,
    totalEuT,
    totalEuPerSecond: totalEuT * TICKS_PER_SECOND,
    fuelEstimate: helpers.calculateFuelEstimate(project, totalEuT),
    bottlenecks,
    externalInputs,
    unconsumedOutputs,
    generatedAt: options.generatedAt ?? project.metadata?.updatedAt ?? "unspecified",
    plan: reading.extras,
  };
}
