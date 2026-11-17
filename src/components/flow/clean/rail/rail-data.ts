"use client";

import { useDeferredValue, useMemo } from "react";
import { expandPocketSelection } from "@/lib/model/pocket-connections";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";
import { measureSelectionFlow } from "@/lib/solver/selection-flow";
import { useFactoryStore } from "@/store/factory-store";
import { buildRailModel, buildResourceLookup, RAIL_EPS, type RailLine, type RailModel } from "./rail-model";
import { buildSpares, type SpareView } from "./spare-model";

/**
 * The rail's and the popup's data for one (project, solve), worked out once
 * and shared: the overview, the spare popup and the notices all read the same
 * model, and a plan of hundreds of cards makes it a real cost.
 */
export interface RailData {
  rail: RailModel;
  spares: SpareView[];
}

let cache:
  | { project: FactoryProject; result: ThroughputResult | undefined; data: RailData }
  | undefined;

export function railData(project: FactoryProject, result: ThroughputResult | undefined): RailData {
  if (cache && cache.project === project && cache.result === result) return cache.data;
  const rail = buildRailModel(project, result);
  const data: RailData = { rail, spares: buildSpares(project, result, rail) };
  cache = { project, result, data };
  return data;
}

export function useRailData(): RailData {
  // Deferred: an edit paints on the board first and the rail follows in a render of its own (its model is about
  // 100 ms of a 1,000-card edit, which kept the click's first paint waiting).
  const liveProject = useFactoryStore((state) => state.project);
  const liveResult = useFactoryStore((state) => state.lastResult);
  const project = useDeferredValue(liveProject);
  const result = useDeferredValue(liveResult);
  return useMemo(() => railData(project, result), [project, result]);
}

export function useRailSelection(enabled: boolean) {
  const liveProject = useFactoryStore((state) => state.project);
  const liveResult = useFactoryStore((state) => state.lastResult);
  const project = useDeferredValue(liveProject);
  const result = useDeferredValue(liveResult);
  const ids = useFactoryStore((state) => enabled ? state.selectedBoardIds : undefined);
  const selection = useMemo(() => {
    if (!ids?.length) return undefined;
    const { itemIds } = expandPocketSelection(project, ids);
    const machines = project.nodes.filter(({ id }) => itemIds.has(id)).length;
    const drawers = (project.storages ?? []).filter(({ id }) => itemIds.has(id)).length;
    return machines || drawers ? { itemIds, machines, drawers } : undefined;
  }, [project, ids]);
  const hasSelection = Boolean(selection);
  const lookup = useMemo(() => hasSelection ? buildResourceLookup(project) : undefined, [hasSelection, project]);
  const resources = useMemo(() => {
    if (!selection || !lookup || result.stale) return undefined;
    const flow = measureSelectionFlow(project, result, selection.itemIds);
    const lines = (rows: typeof flow.inputs): RailLine[] => rows
      .filter((row) => row.amountPerSecond > RAIL_EPS)
      .sort((a, b) => b.amountPerSecond - a.amountPerSecond)
      .map(({ key, kind, resourceId, displayName, amountPerSecond }) => {
        const resource = lookup.get(key) ?? { kind, id: resourceId, displayName };
        return {
          key, kind, resourceId, resource,
          label: resource.displayName ?? displayName ?? resourceId,
          amount: amountPerSecond,
          energy: kind === "power",
          drawers: [],
          pins: [],
          open: [],
        };
      });
    return { inputs: lines(flow.inputs), outputs: lines(flow.outputs), internal: lines(flow.internal) };
  }, [project, result, selection, lookup]);
  const pending = result.stale || liveResult.stale;
  return selection ? { machines: selection.machines, drawers: selection.drawers, resources: pending ? undefined : resources } : undefined;
}
