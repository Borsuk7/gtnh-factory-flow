"use client";

import { useMemo, useState } from "react";
import type { FactoryNode, MachineHandler, Recipe } from "@/lib/model/types";
import { formatCompact } from "@/lib/model/resources";
import { TICKS_PER_SECOND } from "@/lib/model/types";
import { getVoltageTierIndex } from "@/lib/model/tiers";
import { machineSwitchPatch, normalizeHatchInput } from "@/lib/solver/hatch-input";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { getNodePowerReport, getNodeSteamReport } from "@/lib/solver/power-report";
import { ArtBox } from "./ArtBox";
import { getMachineGroup, orderMachineHandlers } from "../../MachinePicker";
import { machineIconAtTier, useMachineHandlerIconEntries, useRecipeMapIcons, type MachineHandlerIcon } from "../../machine-icons";
import { MenuPortal, type MenuAnchor } from "./MenuPortal";

type ComparisonOrder = "name" | "tier" | "ticks" | "parallels" | "power";

/**
 * The machine list (the mod's picker): a compact menu under the name headed "Machines that run this recipe", a row a
 * machine (its picture, its name, "Multiblock" or its kind on the right), the one in use gold. Pick one and the card
 * becomes that machine; the wheel on the name steps through the same order.
 */
export function MachineListMenu({
  anchor,
  recipe,
  node,
  handlers,
  selectedId,
  recipeMap,
  onUse,
  onClose,
}: {
  anchor: MenuAnchor;
  recipe: Recipe;
  node: FactoryNode;
  handlers: MachineHandler[];
  selectedId: string;
  recipeMap: string;
  onUse: (id: string) => void;
  onClose: () => void;
}) {
  const entries = useMachineHandlerIconEntries();
  const mapIcons = useRecipeMapIcons();
  const [compare, setCompare] = useState(false);
  const [sort, setSort] = useState<ComparisonOrder>("name");
  const ordered = useMemo(() => orderMachineHandlers(handlers), [handlers]);
  const mapIcon = mapIcons.get(recipeMap) as MachineHandlerIcon | undefined;
  const comparisons = useMemo(() => {
    if (!compare) return [];
    return ordered.map((handler) => {
      const preview = handler.id === selectedId ? node : normalizeHatchInput(recipe, {
        ...node, ...machineSwitchPatch(recipe, node, handler),
      });
      const clock = getOverclockedRecipeStats(recipe, preview);
      const steam = getNodeSteamReport(recipe, preview);
      const electric = getNodePowerReport(recipe, preview);
      return {
        handler,
        tier: clock.tier,
        ticks: clock.durationTicks,
        parallels: steam?.parallels ?? electric.parallels,
        power: steam?.drawSteamPerTick ?? electric.drawEuT,
        unit: steam ? "L/t steam" : "EU/t",
        stalled: !steam && electric.state !== "ok",
      };
    }).sort((a, b) => {
      if (sort === "name") return a.handler.label.localeCompare(b.handler.label);
      if (sort === "tier") return getVoltageTierIndex(a.tier) - getVoltageTierIndex(b.tier);
      if (sort === "power") return a.unit.localeCompare(b.unit) || a.power - b.power;
      return sort === "parallels" ? b.parallels - a.parallels : a.ticks - b.ticks;
    });
  }, [compare, node, ordered, recipe, selectedId, sort]);
  return (
    <MenuPortal anchor={anchor} width={compare ? 520 : 381} maxHeight={533} label="Machines that run this recipe" onClose={onClose}>
      <div className="cm-head">Machines that run this recipe</div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" className="cm-compare-key" aria-pressed={compare} onClick={() => setCompare(!compare)}>Compare machines</button>
        {compare ? <label>Sort <select className="cm-compare-key" value={sort} onChange={(e) => setSort(e.target.value as ComparisonOrder)}>
          <option value="name">Name</option><option value="tier">Tier</option><option value="ticks">Cycle time</option>
          <option value="parallels">Parallels</option><option value="power">Power draw</option>
        </select></label> : null}
      </div>
      <div className="cm-scroll">
        {compare ? <p className="px-3 pb-2 text-fg-muted">Per machine, with the settings used when you pick it.</p> : null}
        {(compare ? comparisons.map((row) => row.handler) : ordered).map((handler, index) => {
          const row = compare ? comparisons[index] : undefined;
          const own = machineIconAtTier(entries.get(handler.id), row?.tier ?? handler.minimumTier);
          const icon = own ?? mapIcon;
          return (
            <div
              key={handler.id}
              role="menuitem"
              tabIndex={0}
              className="cm-row"
              style={row ? { height: "auto", minHeight: 48, paddingBlock: 4 } : undefined}
              data-current={handler.id === selectedId ? "" : undefined}
              onClick={() => onUse(handler.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onUse(handler.id);
              }}
            >
              <ArtBox src={icon?.iconPath} atlas={icon && !icon.iconPath ? { ...icon, displayName: icon.displayName ?? handler.label } : undefined} size={18} />
              {/* The recipe map's picture stands in for a machine with none of its own, never its name (a bee's map is named for the species). */}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{own?.displayName ?? handler.label}</span>
                {row ? <span className="block whitespace-normal text-fg-muted">
                  {row.tier} · {formatCompact(row.ticks / TICKS_PER_SECOND)} s · {formatCompact(row.parallels)}× parallel · {formatCompact(row.power)} {row.unit}
                  {row.stalled ? " · Power limited" : ""}
                </span> : null}
              </span>
              {row ? null : <span className="cm-note">{getMachineGroup(handler)}</span>}
            </div>
          );
        })}
      </div>
    </MenuPortal>
  );
}
