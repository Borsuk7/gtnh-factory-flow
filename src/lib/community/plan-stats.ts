import type { FactoryProject, MachineTier, ResourceKey, ThroughputResult } from "@/lib/model/types";
import { GT_VOLTAGE_TIERS, getVoltageTierIndex } from "@/lib/model/tiers";
import { getNodeMachineBuildCount } from "@/lib/model/passive-production";
import { buildMachineList } from "@/lib/model/machine-list";
import {
  COMMUNITY_RESOURCE_STAT_LIMIT,
  type CommunityPlanStats,
  type PlanResourceStat,
} from "./types";

const VOLTAGE_TIER_SET = new Set<string>(GT_VOLTAGE_TIERS.map((entry) => entry.tier));

function isVoltageTier(value: unknown): value is Exclude<MachineTier, "DEMO"> {
  return typeof value === "string" && VOLTAGE_TIER_SET.has(value);
}

/**
 * Derives the community stat card for a plan. Pure in (project, result), so
 * the server can recompute it from the uploaded JSON instead of trusting
 * client-supplied numbers.
 *
 * `resourceLimit` caps the needs/makes lists; the community shelves keep the
 * default, while the image export asks for everything.
 */
export function computeCommunityPlanStats(
  project: FactoryProject,
  result: ThroughputResult,
  resourceLimit: number = COMMUNITY_RESOURCE_STAT_LIMIT,
): CommunityPlanStats {
  return computePlanStats(project, result, resourceLimit, false);
}

export function computeScreenshotPlanStats(project: FactoryProject, result: ThroughputResult): CommunityPlanStats {
  return computePlanStats(project, result, Number.POSITIVE_INFINITY, true);
}

function computePlanStats(
  project: FactoryProject,
  result: ThroughputResult,
  resourceLimit: number,
  includeForcedFlows: boolean,
): CommunityPlanStats {
  let highestTierIndex = -1;
  let highestTier: Exclude<MachineTier, "DEMO"> | undefined;
  let machineCount = 0;
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));

  for (const node of project.nodes) {
    if (!node.enabled) {
      continue;
    }

    // A crop card's machineCount is planted crops, not machines: it counts
    // the managers or farms those crops fill, and hand-picked crops nothing.
    machineCount += getNodeMachineBuildCount(recipesById.get(node.recipeId), node);
    if (isVoltageTier(node.overclockTier)) {
      const index = getVoltageTierIndex(node.overclockTier);
      if (index > highestTierIndex) {
        highestTierIndex = index;
        highestTier = node.overclockTier;
      }
    }
  }

  if (project.planMode) {
    // On the plan board a card's count is the solver's answer, not what was
    // built: the machines to buy are the solved counts rounded up per card.
    machineCount = buildMachineList(project, result).reduce(
      (sum, entry) => sum + Math.max(0, Math.ceil(entry.count - 0.000001)),
      0,
    );
  }

  const icons = buildResourceIconIndex(project);
  const needs = toResourceStats(result.externalInputs, includeForcedFlows && result.plan ? "imported" : "consumed", icons, resourceLimit);
  const outputs = toResourceStats(result.unconsumedOutputs, "produced", icons, resourceLimit);
  if (includeForcedFlows) {
    addForcedFlows(needs, outputs, result, icons);
  }
  return {
    nodeCount: project.nodes.length,
    storageCount: (project.storages ?? []).length,
    edgeCount: project.edges.length,
    machineCount,
    totalEuT: Number.isFinite(result.totalEuT) ? result.totalEuT : 0,
    highestTier,
    highestTierIndex,
    needs,
    outputs,
  };
}

type ResourceIconInfo = Pick<
  PlanResourceStat,
  "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
>;

/** Add flows through solver gates to the drawer totals. Buffer spills already appear in the output balances. */
function addForcedFlows(
  needs: PlanResourceStat[],
  outputs: PlanResourceStat[],
  result: ThroughputResult,
  icons: Map<string, ResourceIconInfo>,
): void {
  const byKey = (rows: PlanResourceStat[]) => new Map(rows.map((row) => [`${row.kind}:${row.resourceId}`, row]));
  const inputByKey = byKey(needs);
  const outputByKey = byKey(outputs);
  for (const flow of result.plan?.forced ?? []) {
    if (!(flow.perSecond > 0) || !Number.isFinite(flow.perSecond)) continue;
    const key = flow.resourceKey as ResourceKey;
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon);
    if (kind !== "item" && kind !== "fluid" && kind !== "aspect") continue;
    const index = flow.side === "in" ? inputByKey : outputByKey;
    const previous = index.get(key);
    if (previous) {
      previous.ratePerSecond += flow.perSecond;
    } else {
      const icon = icons.get(key);
      const row: PlanResourceStat = {
        ...icon,
        kind,
        resourceId: key.slice(colon + 1),
        displayName: result.resources[key]?.displayName ?? icon?.displayName,
        ratePerSecond: flow.perSecond,
      };
      index.set(key, row);
      (flow.side === "in" ? needs : outputs).push(row);
    }
  }
  needs.sort((a, b) => b.ratePerSecond - a.ratePerSecond);
  outputs.sort((a, b) => b.ratePerSecond - a.ratePerSecond);
}

/**
 * Icon refs live on the recipe/storage resources inside the plan JSON, not on
 * the solver's balances, so index them once by kind:id for the stat lines.
 */
function buildResourceIconIndex(project: FactoryProject): Map<string, ResourceIconInfo> {
  const index = new Map<string, ResourceIconInfo>();
  const add = (resource: {
    kind: string;
    id: string;
    displayName?: string;
    iconPath?: string;
    iconAtlas?: PlanResourceStat["iconAtlas"];
    dominantColor?: string;
  }) => {
    const key = `${resource.kind}:${resource.id}`;
    if (!index.has(key) && (resource.iconPath || resource.iconAtlas)) {
      index.set(key, {
        displayName: resource.displayName,
        iconPath: resource.iconPath,
        iconAtlas: resource.iconAtlas,
        dominantColor: resource.dominantColor,
      });
    }
  };

  for (const recipe of project.recipes) {
    recipe.inputs.forEach(add);
    recipe.outputs.forEach(add);
  }
  for (const storage of project.storages ?? []) {
    add({
      kind: storage.kind,
      id: storage.resourceId,
      displayName: storage.displayName,
      iconPath: storage.iconPath,
      iconAtlas: storage.iconAtlas,
      dominantColor: storage.dominantColor,
    });
  }

  return index;
}

function toResourceStats(
  balances: ThroughputResult["externalInputs"],
  direction: "consumed" | "imported" | "produced",
  icons: Map<string, ResourceIconInfo>,
  limit: number = COMMUNITY_RESOURCE_STAT_LIMIT,
): PlanResourceStat[] {
  return balances
    .map((balance) => {
      const icon = icons.get(`${balance.kind}:${balance.resourceId}`);
      return {
        kind: balance.kind,
        resourceId: balance.resourceId,
        displayName: balance.displayName ?? icon?.displayName,
        iconPath: icon?.iconPath,
        iconAtlas: icon?.iconAtlas,
        dominantColor: icon?.dominantColor,
        ratePerSecond:
          direction === "consumed"
            ? Math.abs(balance.consumedPerSecond)
            : direction === "imported"
              ? balance.importedPerSecond
              : Math.abs(balance.surplusPerSecond || balance.producedPerSecond),
      };
    })
    .filter((stat) => stat.ratePerSecond > 0)
    .sort((a, b) => b.ratePerSecond - a.ratePerSecond)
    .slice(0, Number.isFinite(limit) ? limit : balances.length);
}
