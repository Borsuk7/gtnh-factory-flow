import { isCustomRateRecipe } from "@/lib/model/custom-rate";
import { pinRuleOf, withPinRule } from "@/lib/model/pin-rule";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";

export interface MachineSize {
  id: string;
  name: string;
  used: number;
  count: number;
}

export function suggestPlanSizes(
  project: FactoryProject,
  result: ThroughputResult,
  scope?: ReadonlySet<string>,
): MachineSize[] {
  if (!result.plan || result.stale || result.plan.failure) return [];
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  return project.nodes.flatMap((node) => {
    if (scope && !scope.has(node.id)) return [];
    const recipe = recipes.get(node.recipeId);
    const row = result.nodes[node.id];
    if (!recipe || !row?.enabled || row.powerStalled || pinRuleOf(node, recipe) !== "any" ||
        recipe.power || isCustomRateRecipe(recipe) || node.extraRecipes?.length) return [];
    const used = row.theoreticalMachinesRequired;
    if (!Number.isFinite(used) || used <= 1e-6) return [];
    return [{ id: node.id, name: row.recipeName, used, count: Math.ceil(used - 1e-7) }];
  });
}

export function planWithMachineSizes(project: FactoryProject, sizes: readonly MachineSize[]): FactoryProject {
  const byId = new Map(sizes.map(({ id, count }) => [id, count]));
  return { ...project, nodes: project.nodes.map((node) => {
    const count = byId.get(node.id);
    return count === undefined ? node : withPinRule(node, "upTo", count);
  }) };
}

function sameRate(before: number, after: number): boolean {
  return Math.abs(before - after) <= Math.max(1e-5, Math.abs(before) * 1e-6);
}

export function verifyPlanSizes(project: FactoryProject, before: ThroughputResult, after: ThroughputResult): boolean {
  if (!after.plan || after.plan.failure) return false;
  const beforeUnmet = new Set(before.plan?.unmetDrawers ?? []);
  if (after.plan.unmetDrawers?.some((id) => !beforeUnmet.has(id))) return false;
  const forced = (result: ThroughputResult) => new Map(result.plan?.forced.map(
    (flow) => [JSON.stringify([flow.nodeId, flow.portKey, flow.side, flow.resourceKey]), flow.perSecond],
  ));
  const forcedBefore = forced(before);
  const forcedAfter = forced(after);
  return new Set([...forcedBefore.keys(), ...forcedAfter.keys()]).size === forcedBefore.size &&
    [...forcedBefore].every(([key, rate]) => sameRate(rate, forcedAfter.get(key) ?? 0)) &&
    project.edges.every(({ id }) => sameRate(
      before.edges[id]?.transferredPerSecond ?? 0,
      after.edges[id]?.transferredPerSecond ?? 0,
    ));
}
