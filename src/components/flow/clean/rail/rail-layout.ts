import {
  visibleLines,
  type RailDrawer,
  type RailLine,
  type RailMachine,
  type RailModel,
  type RailPin,
} from "./rail-model";
import { sparedByResource, type SpareView } from "./spare-model";

/**
 * The rail's list as a flat run of items with their tops and heights. Pure,
 * so the component draws only what is in view (a plan of hundreds of
 * resources) and the spare slider can be kept still on screen by comparing two
 * layouts. The structure is the mod's `OverviewRail.list`.
 */

/** The mod's 12 and 13 px bars and rows (OverviewRail.SECTION_H, ROW_H), 24 and 26 screen px at GUI scale 2. */
export const SECTION_H = 20;
export const ROW_H = 22;
export const SETTER_H = 20;
export const SPARE_HEAD_H = 22;
export const POWER_H = 20;
export const GAP = 4;

export type SectionId = "INPUTS" | "OUTPUTS" | "INTERNAL" | "MACHINES";

export type Setter = RailDrawer | RailPin;

export type RailItem =
  | { t: "section"; id: SectionId; count: number; shown: number; folded: boolean }
  | { t: "empty"; text: string; pending?: boolean }
  | {
      t: "line";
      section: "inputs" | "outputs" | "internal";
      line: RailLine;
      amount: number;
      setters: Setter[];
    }
  | { t: "spare"; spare: SpareView; shownInSection: boolean }
  | { t: "power"; label: "Made" | "Net"; value: number }
  | { t: "group"; name: string; entries: RailMachine[] }
  | { t: "machine"; entry: RailMachine }
  | { t: "gap" };

export interface Placed {
  item: RailItem;
  top: number;
  height: number;
  key: string;
}

export interface LayoutInput {
  rail: RailModel;
  spares: readonly SpareView[];
  filter: string;
  folded: ReadonlySet<string>;
  peak: boolean;
  selection?: { resources?: Pick<RailModel, "inputs" | "outputs" | "internal"> };
}

const matches = (filter: string, label: string) => {
  const f = filter.trim().toLowerCase();
  return f === "" || label.toLowerCase().includes(f);
};

export function spareHeight(spare: SpareView): number {
  return SPARE_HEAD_H + spare.bearers.length * ROW_H + 2;
}

export function lineHeight(setterCount: number): number {
  return ROW_H + Math.max(0, setterCount - 1) * SETTER_H;
}

export function layoutRail(input: LayoutInput): { placed: Placed[]; height: number; resourcesHeight: number } {
  const { rail, spares, filter, folded, peak, selection } = input;
  const placed: Placed[] = [];
  let y = 0;
  const push = (item: RailItem, height: number, key: string) => {
    placed.push({ item, top: y, height, key });
    y += height;
  };

  const choiceSpares = (importing: boolean) =>
    spares.filter(
      (s) =>
        s.importing === importing &&
        s.bearers.length >= 2 &&
        s.bearers.some((b) => matches(filter, b.name)),
    );

  const resources = (
    id: "INPUTS" | "OUTPUTS" | "INTERNAL",
    section: "inputs" | "outputs" | "internal",
    lines: readonly RailLine[],
    empty: string,
  ) => {
    const sources = section === "inputs";
    const spared =
      section === "internal" ? new Map<string, number>() : sparedByResource(spares, sources);
    const kept = visibleLines(lines, section, spared);
    const shown = kept.filter(({ line }) => matches(filter, line.label));
    const groups = section === "internal" ? [] : choiceSpares(sources);
    const isFolded = folded.has(id);
    push(
      {
        t: "section",
        id,
        count: kept.length + groups.length,
        shown: shown.length + groups.length,
        folded: isFolded,
      },
      SECTION_H,
      `s:${id}`,
    );
    if (isFolded) {
      y += GAP;
      return;
    }
    if (shown.length === 0 && groups.length === 0) {
      push({ t: "empty", text: kept.length === 0 ? empty : "No matches." }, ROW_H, `e:${id}`);
      y += GAP;
      return;
    }
    for (const { line, amount } of shown) {
      const setters: Setter[] = section === "internal" ? [] : [...line.drawers, ...line.pins];
      push(
        { t: "line", section, line, amount, setters },
        lineHeight(setters.length),
        `l:${section}:${line.key}`,
      );
    }
    for (const spare of groups) {
      y += 2;
      push({ t: "spare", spare, shownInSection: true }, spareHeight(spare), `p:${spare.key}`);
    }
    y += GAP;
  };

  if (selection && !selection.resources) {
    push({ t: "empty", text: "Calculating plan…", pending: true }, ROW_H, "e:pending");
    y += GAP;
  } else {
    const totals = selection?.resources ?? rail;
    resources("INPUTS", "inputs", totals.inputs, selection ? "No inputs." : "Nothing missing.");
    resources("OUTPUTS", "outputs", totals.outputs, selection ? "No outputs." : "Nothing coming out yet.");
    resources("INTERNAL", "internal", totals.internal, "Nothing internal.");
  }

  const resourcesHeight = y;
  // A folded section keeps its sliders reachable: they are not drawn, but a held bar is found by key.
  const groupsOf = new Map<string, RailMachine[]>();
  for (const entry of rail.machines) {
    if (!matches(filter, entry.label)) continue;
    const list = groupsOf.get(entry.label);
    if (list) list.push(entry);
    else groupsOf.set(entry.label, [entry]);
  }
  const whole = rail.wholeMachines;
  const shownWhole = [...groupsOf.values()]
    .flat()
    .reduce((t, e) => t + Math.ceil(e.count - 1e-9), 0);
  const machinesFolded = folded.has("MACHINES");
  push(
    { t: "section", id: "MACHINES", count: whole, shown: shownWhole, folded: machinesFolded },
    SECTION_H,
    "s:MACHINES",
  );
  if (machinesFolded) {
    y += GAP;
    return { placed, height: y, resourcesHeight };
  }
  const used = peak ? rail.power.peak : rail.power.average;
  if (rail.power.hasMade) {
    push({ t: "power", label: "Made", value: used.made }, POWER_H, "w:made");
    push({ t: "power", label: "Net", value: used.made - used.used }, POWER_H, "w:net");
    y += 2;
  }
  if (groupsOf.size === 0) {
    push(
      { t: "empty", text: rail.machines.length === 0 ? "No machines yet." : "No matches." },
      ROW_H,
      "e:MACHINES",
    );
    y += GAP;
    return { placed, height: y, resourcesHeight };
  }
  for (const [name, entries] of groupsOf) {
    push({ t: "group", name, entries }, ROW_H, `g:${name}`);
    for (const entry of entries) push({ t: "machine", entry }, ROW_H, `m:${entry.nodeId}`);
    y += 1;
  }
  y += GAP;
  return { placed, height: y, resourcesHeight };
}

/** The items overlapping [from, to]. */
export function visibleSlice(placed: readonly Placed[], from: number, to: number): Placed[] {
  // Binary search for the first item ending after `from`.
  let lo = 0;
  let hi = placed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = placed[mid]!;
    if (p.top + p.height <= from) lo = mid + 1;
    else hi = mid;
  }
  const out: Placed[] = [];
  for (let i = lo; i < placed.length && placed[i]!.top < to; i += 1) out.push(placed[i]!);
  return out;
}
