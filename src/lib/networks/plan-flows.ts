import type { FactoryProject, ThroughputResult } from "@/lib/model/types";
import { buildMachineList } from "@/lib/model/machine-list";
import type { PlanFlows } from "./model";

export function planFlows(project: FactoryProject, result: ThroughputResult): PlanFlows {
  const machines = buildMachineList(project, result);
  const failure = result.plan?.failure;
  return {
    materials: Object.values(result.resources)
      .filter((row) => row.kind !== "power")
      .map((row) => ({
        key: row.key,
        kind: row.kind,
        resourceId: row.resourceId,
        label: row.displayName ?? row.resourceId,
        supply: row.productPerSecond + row.byproductPerSecond + row.bufferFillPerSecond,
        demand: row.importedPerSecond,
      }))
      .filter((row) => row.supply > 0 || row.demand > 0),
    power: {
      used: machines.reduce((sum, machine) => sum + (machine.avgEuT ?? 0), 0),
      made: machines.reduce((sum, machine) => sum + (machine.avgMadeEuT ?? 0), 0),
    },
    stale: result.stale,
    error: Object.values(result.nodes).some((node) => node.status === "missing-recipe")
      ? "Missing recipe"
      : failure
        ? failure.message === "NO_PIN"
          ? "Set a rate or machine count in this plan"
          : "The plan could not be solved"
        : undefined,
  };
}
