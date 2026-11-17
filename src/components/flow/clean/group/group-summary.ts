import { isCustomRateRecipe } from "@/lib/model/custom-rate";
import { pinRuleOf } from "@/lib/model/pin-rule";
import { isFluidTankRecipe } from "@/lib/model/fluid-tank";
import { buildMachineList } from "@/lib/model/machine-list";
import type {
  FactoryPocket,
  FactoryProject,
  ResourceKind,
  ThroughputResult,
} from "@/lib/model/types";
import { buildResourceLookup, splitResultNodeId, type RailResource } from "../rail/rail-model";

/**
 * What a collapsed group's summary card says (docs/groups.md, "What the summary says"): from the plan-wide solve,
 * never a solve of the group alone, over its members and every group nested in it.
 *
 * - machines: each machine card's build count (solved count rounded up, a pinned count as pinned); a shared machine
 *   once; drawers, notes and planning cards are not machines;
 * - EU/t: the members' power as the overview counts it (peak or average, its dial);
 * - in and out: per resource, the members' solved consumption minus their solved production (the card's own
 *   numbers: count times per-machine rate), busiest first.
 */

const EPS = 1e-6;

export interface GroupFlow {
  key: string;
  kind: ResourceKind;
  resourceId: string;
  resource: RailResource;
  /** Units a second (EU a second for power). */
  perSecond: number;
}

export interface GroupSummary {
  machines: number;
  euT: number;
  inputs: GroupFlow[];
  outputs: GroupFlow[];
}

interface NetFlow {
  kind: ResourceKind;
  resourceId: string;
  label?: string;
  value: number;
  order: number;
}

function mergeFlow(net: Map<string, NetFlow>, key: string, flow: NetFlow) {
  const previous = net.get(key);
  if (!previous) {
    net.set(key, flow);
  } else {
    const first = previous.order < flow.order ? previous : flow;
    net.set(key, { ...first, value: previous.value + flow.value });
  }
}

function emptyGroup() {
  return { machines: 0, euT: 0, net: new Map<string, NetFlow>() };
}

export function computeGroupSummaries(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  pocketIds: readonly string[],
  peak: boolean,
  flowsFor: ReadonlySet<string> = new Set(pocketIds),
): Map<string, GroupSummary> {
  const out = new Map<string, GroupSummary>();
  if (pocketIds.length === 0) return out;
  const pocketsById = new Map((project.pockets ?? []).map((pocket) => [pocket.id, pocket]));
  const childrenById = new Map<string, FactoryPocket[]>();
  for (const pocket of pocketsById.values()) {
    const parent = pocket.parentPocketId;
    if (parent === undefined) continue;
    const children = childrenById.get(parent);
    if (children) children.push(pocket);
    else childrenById.set(parent, [pocket]);
  }
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  const lookup = flowsFor.size ? buildResourceLookup(project) : new Map<string, RailResource>();
  const entries = result ? buildMachineList(project, result) : [];
  // A failed solve leaves each card's nominal single craft in its result: not flows of the plan.
  const answered = result !== undefined && result.plan?.failure === undefined;

  const details = new Set<string>();
  const pending = [...flowsFor];
  while (pending.length) {
    const id = pending.pop()!;
    if (details.has(id)) continue;
    details.add(id);
    for (const child of childrenById.get(id) ?? []) pending.push(child.id);
  }
  const groups = new Map<string, ReturnType<typeof emptyGroup>>();
  const groupFor = (id: string) => {
    let group = groups.get(id);
    if (!group) {
      group = emptyGroup();
      groups.set(id, group);
    }
    return group;
  };

  for (const entry of entries) {
    const node = nodesById.get(entry.nodeId);
    if (node?.pocketId === undefined || isFluidTankRecipe(recipes.get(node.recipeId))) continue;
    const pin = node.solvePin;
    const rule = pinRuleOf(node);
    const pinned = rule !== "any" && pin !== undefined && pin > 0;
    // An Up to card builds what runs (the solver's read-out), an Exactly card its set count.
    const running = rule === "upTo" ? result?.plan?.upTo?.[entry.nodeId]?.reached : undefined;
    if (!pinned && !(entry.count > 1e-9)) continue;
    const group = groupFor(node.pocketId);
    group.machines += Math.ceil((running ?? (pinned ? pin : entry.count)) - 1e-9);
    group.euT += (peak ? entry.euT : entry.avgEuT) ?? 0;
  }

  if (answered && details.size) {
    let order = 0;
    for (const node of Object.values(result.nodes)) {
      if (!node.enabled) continue;
      const { cardId } = splitResultNodeId(node.nodeId);
      const owner = nodesById.get(cardId)?.pocketId;
      if (owner === undefined || !details.has(owner)) continue;
      if (isCustomRateRecipe(recipes.get(node.recipeId))) continue;
      // A machine at zero keeps its nameplate rates for its port rows.
      if (!(node.theoreticalMachinesRequired > 1e-9)) continue;
      const { net } = groupFor(owner);
      const running = Math.min(1, Math.max(0, node.utilization ?? 1));
      for (const [flows, sign] of [[node.inputs, 1], [node.outputs, -1]] as const) {
        for (const flow of Object.values(flows)) {
          mergeFlow(net, flow.key, {
            kind: flow.kind,
            resourceId: flow.resourceId,
            label: flow.displayName,
            value: sign * flow.amountPerSecond * running,
            order: order++,
          });
        }
      }
    }
  }

  // A group joins its parent after all its children have joined it.
  const remaining = new Map([...childrenById].map(([id, children]) => [id, children.length]));
  const ready = [...pocketsById.keys()].filter((id) => !remaining.has(id));
  while (ready.length) {
    const id = ready.pop()!;
    const parent = pocketsById.get(id)?.parentPocketId;
    if (parent === undefined || !pocketsById.has(parent)) continue;
    const childGroup = groups.get(id);
    if (childGroup) {
      const parentGroup = groupFor(parent);
      parentGroup.machines += childGroup.machines;
      parentGroup.euT += childGroup.euT;
      if (details.has(parent)) {
        for (const [key, flow] of childGroup.net) mergeFlow(parentGroup.net, key, flow);
      }
    }
    const count = remaining.get(parent)! - 1;
    remaining.set(parent, count);
    if (count === 0) ready.push(parent);
  }

  for (const pocketId of pocketIds) {
    const { machines, euT, net } = groups.get(pocketId) ?? emptyGroup();
    const inputs: GroupFlow[] = [];
    const outputs: GroupFlow[] = [];
    for (const [key, entry] of flowsFor.has(pocketId) ? net : []) {
      if (Math.abs(entry.value) <= EPS) continue;
      const known = lookup.get(key);
      const resource: RailResource = {
        ...(known ?? { kind: entry.kind, id: entry.resourceId }),
        displayName: known?.displayName ?? entry.label ?? entry.resourceId,
      };
      const flow = {
        key,
        kind: entry.kind,
        resourceId: entry.resourceId,
        resource,
        perSecond: Math.abs(entry.value),
      };
      (entry.value > 0 ? inputs : outputs).push(flow);
    }
    const busiest = (a: GroupFlow, b: GroupFlow) =>
      b.perSecond - a.perSecond || net.get(a.key)!.order - net.get(b.key)!.order;
    inputs.sort(busiest);
    outputs.sort(busiest);
    out.set(pocketId, { machines, euT, inputs, outputs });
  }
  return out;
}

/** Rows the summary card draws: the longer list (at least one: the "Nothing goes in or out." line). */
export function summaryRows(summary: GroupSummary | undefined): number {
  if (!summary) return 1;
  return Math.max(1, summary.inputs.length, summary.outputs.length);
}
