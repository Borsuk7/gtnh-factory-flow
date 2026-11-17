"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { rateMultiplierForKind, rateSuffixForKind } from "@/lib/model/rate-unit";
import { formatCompact } from "@/lib/model/resources";
import { listNodeSections } from "@/lib/model/shared-machine";
import { pinRuleOf, withPinRule } from "@/lib/model/pin-rule";
import { getStorageRoles } from "@/lib/model/storage-role";
import { storageTargetMode, type TargetMode } from "@/lib/model/storage-target";
import type { FactoryProject, FactoryStorage, ResourceBalance, ResourceFlow, ResourceKind, ThroughputResult } from "@/lib/model/types";
import { expandPocketSelection } from "@/lib/model/pocket-connections";
import { selectTrendSeries, useResourceTrends } from "@/lib/resource-trends";
import { measureSelectionFlow, prepareSelectionFlow, type SelectionFlow } from "@/lib/solver/selection-flow";
import { planWithMachineSizes, suggestPlanSizes, verifyPlanSizes } from "@/lib/solver/plan-sizing";
import { useFactoryStore, useRateDisplayUnits } from "@/store/factory-store";
import { solvePreview } from "@/store/solve-books";
import { shownReason, UP_TO_WORD, upToSentence } from "../up-to-reason";
import { frameCards } from "./rail-actions";

export const OVERVIEW_VIEWS = {
  plan: "Plan",
  selection: "Selection",
  worksheet: "Worksheet",
  trends: "Resource trends",
  bottlenecks: "Bottlenecks",
  sizing: "Machine sizing",
} as const;
export type OverviewView = keyof typeof OVERVIEW_VIEWS;
type AnalysisProps = { project: FactoryProject; result: ThroughputResult; ids: readonly string[] };
type FlowRow = { key: string; kind: ResourceKind; name: string; rate: number };

function displayRate(rate: number, kind: ResourceKind): string {
  return `${formatCompact(rate * rateMultiplierForKind(kind))}${rateSuffixForKind(kind)}`;
}

export function PlanAnalysis({ view }: { view: Exclude<OverviewView, "plan"> }) {
  const liveProject = useFactoryStore((state) => state.project);
  const liveResult = useFactoryStore((state) => state.lastResult);
  const project = useDeferredValue(liveProject);
  const result = useDeferredValue(liveResult);
  const ids = useFactoryStore((state) => state.selectedBoardIds);
  useRateDisplayUnits();
  const props = { project, result, ids };
  return <>
    {result.stale ? <div className="rail-analysis" role="status">Calculating plan…</div> : null}
    <div className="rail-list rail-analysis" key={view} hidden={result.stale}>
      {view === "selection" ? <Selection {...props} /> : null}
      {view === "worksheet" ? <Worksheet {...props} /> : null}
      {view === "trends" ? <Trends result={result} /> : null}
      {view === "bottlenecks" ? <Bottlenecks {...props} /> : null}
      {view === "sizing" ? <Sizing {...props} /> : null}
    </div>
  </>;
}

function wireRow(flow: ResourceFlow): FlowRow {
  return { key: flow.key, kind: flow.kind, name: flow.displayName ?? flow.resourceId, rate: flow.amountPerSecond };
}

function FlowList({ title, rows }: { title: string; rows: FlowRow[] }) {
  return <section>
    <h3>{title}</h3>
    {rows.length ? <dl>{[...rows].sort((a, b) => b.rate - a.rate).map((row) => (
      <div key={row.key}><dt>{row.name}</dt><dd>{displayRate(row.rate, row.kind)}</dd></div>
    ))}</dl> : <p>None</p>}
  </section>;
}

function Selection({ project, result, ids }: AnalysisProps) {
  const actual = useMemo(() => measureSelectionFlow(project, result, ids), [project, result, ids]);
  const [scoped, setScoped] = useState<{ base: FactoryProject; ids: readonly string[]; flow?: SelectionFlow; assumption?: string }>();
  const current = scoped?.base === project && scoped.ids === ids ? scoped : undefined;
  const flow = current?.flow;
  const [anchorId, setAnchorId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  if (!actual.itemIds.size) return <p>Select cards, drawers, or a group on the board.</p>;
  const machines = project.nodes.filter((node) => node.enabled && actual.itemIds.has(node.id));
  const anchors = machines.filter((node) => pinRuleOf(node) === "any" && !Object.keys(node.portRates ?? {}).length &&
    result.nodes[node.id]?.status !== "missing-recipe" && !result.nodes[node.id]?.powerStalled);
  const anchor = anchors.find((node) => node.id === anchorId) ?? anchors[0];
  const solve = async (oneMachine?: string) => {
    const scenario = prepareSelectionFlow(project, ids, oneMachine ? { id: oneMachine, count: 1 } : undefined);
    if (!scenario || pending) return;
    setPending(true);
    setError(false);
    try {
      const answer = await solvePreview(scenario.project);
      setScoped({
        base: project,
        ids,
        flow: scenario.summarize(answer),
        assumption: oneMachine ? `Preview with one ${result.nodes[oneMachine]?.recipeName ?? "machine"}.` : undefined,
      });
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return <>
    <h2>Current wire flows</h2>
    <FlowList title="Into selection" rows={actual.inputs.map(wireRow)} />
    <FlowList title="Out of selection" rows={actual.outputs.map(wireRow)} />
    <FlowList title="Within selection" rows={actual.internal.map(wireRow)} />
    {machines.length ? <button type="button" className="rail-analysis-key" disabled={pending} onClick={() => void solve()}>
      Solve selection separately
    </button> : null}
    {pending ? <p role="status">Solving selection…</p> : null}
    {error ? <p role="alert">The selection could not be solved.</p> : null}
    {flow ? <section>
      <h2>Separate solve</h2>
      <p>Uses source and drain drawers at the cut connections.</p>
      {current.assumption ? <p>{current.assumption}</p> : null}
      {flow.unsized ? <p>Part of the selection needs a count or rate.</p> : null}
      {flow.unsized && anchor ? <div>
        <label>Use one machine for the preview
          <select className="rail-analysis-key" value={anchor.id} onChange={(event) => setAnchorId(event.target.value)}>
            {anchors.map((node) => <option key={node.id} value={node.id}>{result.nodes[node.id]?.recipeName ?? "Machine"}</option>)}
          </select>
        </label>
        <button type="button" className="rail-analysis-key" disabled={pending} onClick={() => void solve(anchor.id)}>Solve with one machine</button>
      </div> : null}
      <FlowList title="Inputs" rows={flow.externalInputs.map((row) => ({
        key: row.key, name: row.displayName ?? row.resourceId, kind: row.kind, rate: row.deficitPerSecond,
      }))} />
      <FlowList title="Outputs" rows={flow.unconsumedOutputs.map((row) => ({
        key: row.key, name: row.displayName ?? row.resourceId, kind: row.kind, rate: row.surplusPerSecond,
      }))} />
      <FlowList title="Internal" rows={flow.internal.map((row) => ({
        key: row.key, name: row.displayName ?? row.resourceId, kind: row.kind,
        rate: Math.min(row.producedPerSecond, row.consumedPerSecond),
      }))} />
    </section> : null}
  </>;
}

function Worksheet({ project, result, ids }: AnalysisProps) {
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const [showDrawers, setShowDrawers] = useState(false);
  const scope = useMemo(
    () => selectedOnly ? expandPocketSelection(project, ids).itemIds : undefined,
    [project, ids, selectedOnly],
  );
  const rows = useMemo(() => {
    const materials = new Map<string, { name: string; kind: ResourceKind; made: number; used: number }>();
    for (const card of project.nodes) {
      if (scope && !scope.has(card.id)) continue;
      for (const { node } of listNodeSections(card)) {
        const reading = result.nodes[node.id];
        if (!reading?.enabled || !(reading.operationRatePerSecond > 0) || !(reading.utilization > 0)) continue;
        for (const [side, flows] of [["made", reading.outputs], ["used", reading.inputs]] as const) {
          for (const flow of Object.values(flows)) {
            if (flow.kind === "power" || !(flow.amountPerSecond > 0)) continue;
            const row = materials.get(flow.key) ?? { name: flow.displayName ?? flow.resourceId, kind: flow.kind, made: 0, used: 0 };
            row[side] += flow.amountPerSecond;
            materials.set(flow.key, row);
          }
        }
      }
    }
    return [...materials].sort(([, a], [, b]) => a.name.localeCompare(b.name));
  }, [project, result, scope]);
  const search = filter.trim().toLowerCase();
  const shown = rows.filter(([, row]) => row.name.toLowerCase().includes(search));
  const roles = useMemo(() => showDrawers ? getStorageRoles(project) : undefined, [project, showDrawers]);
  const drawers = roles ? (project.storages ?? []).filter((drawer) => {
    const role = roles.get(drawer.id);
    return (role === "source" || role === "product") && (!scope || scope.has(drawer.id)) &&
      (drawer.displayName ?? drawer.resourceId).toLowerCase().includes(search);
  }) : [];
  return <>
    <p>Material rates from running cards.</p>
    <label><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} /> Selected cards only</label>
    <input className="rail-analysis-key" type="search" aria-label="Filter materials" placeholder="Filter materials" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <button type="button" aria-pressed={showDrawers} className="rail-analysis-key" onClick={() => setShowDrawers(!showDrawers)}>
      {showDrawers ? "Show material rates" : "Show drawer rules"}
    </button>
    {roles ? <section>
      <h2>Source and product drawers</h2>
      {drawers.length ? drawers.map((drawer) => <WorksheetDrawer key={drawer.id} drawer={drawer} isSource={roles.get(drawer.id) === "source"} />)
        : <p>No matching drawers.</p>}
    </section> : shown.length ? <table>
      <thead><tr><th>Material</th><th>Made</th><th>Used</th></tr></thead>
      <tbody>{shown.map(([key, row]) => <tr key={key}><th scope="row">{row.name}</th><td>{displayRate(row.made, row.kind)}</td><td>{displayRate(row.used, row.kind)}</td></tr>)}</tbody>
    </table> : <p>No matching material rates.</p>}
  </>;
}

function WorksheetDrawer({ drawer, isSource }: { drawer: FactoryStorage; isSource: boolean }) {
  const locked = useFactoryStore((state) => state.isReadOnly || state.checklistMode);
  const name = drawer.displayName ?? drawer.resourceId;
  const rule = drawer.targetPerSecond === undefined ? "ignore" : storageTargetMode(drawer, isSource ? "source" : "product");
  const multiplier = rateMultiplierForKind(drawer.kind);
  const rate = Math.abs(drawer.targetPerSecond ?? 0) * multiplier;
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? (rate > 0 ? String(Number(rate.toPrecision(10))) : "");
  const update = (mode: TargetMode, amount: number) => {
    const store = useFactoryStore.getState();
    const current = store.project.storages?.find((entry) => entry.id === drawer.id);
    if (current !== drawer || store.isReadOnly || store.checklistMode) return;
    if (mode === "ignore") store.setStorageTargetMode(drawer.id, "ignore");
    else if (Number.isFinite(amount) && amount > 0) store.setStorageRule(drawer.id, mode, amount / multiplier);
  };
  return <div className="worksheet-drawer">
    <button className="rail-analysis-key" type="button" onClick={() => frameCards([drawer.id])}>{name}</button>
    <span>{isSource ? "Source" : "Product"}</span>
    <label>Rule<select className="rail-analysis-key" value={rule} disabled={locked} onChange={(event) => {
      const mode = event.target.value as TargetMode;
      update(mode, rate || multiplier);
    }}>
      <option value="ignore">Any</option><option value="exact">Exactly</option>
      <option value="at-least">At least</option><option value="at-most">At most</option>
    </select></label>
    <label>Rate {rateSuffixForKind(drawer.kind).trim()}
      <input className="rail-analysis-key" inputMode="decimal" value={shown} disabled={locked}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        onBlur={() => {
          if (draft !== undefined) {
            const amount = Number(draft);
            update(amount === 0 ? "ignore" : rule === "ignore" ? (isSource ? "exact" : "at-least") : rule, amount);
            setDraft(undefined);
          }
        }}
      />
    </label>
  </div>;
}

function Trends({ result }: { result: ThroughputResult }) {
  const history = useResourceTrends();
  const [watched, setWatched] = useState<ResourceBalance>();
  const options = Object.values(result.resources).filter((row) => row.kind !== "power")
    .sort((a, b) => (a.displayName ?? a.resourceId).localeCompare(b.displayName ?? b.resourceId));
  const current = options.find((row) => row.key === watched?.key) ?? watched;
  if (current && !options.some((row) => row.key === current.key)) options.unshift(current);
  const series = current ? selectTrendSeries(history, current.key) : [];
  const low = Math.min(0, ...series);
  const span = Math.max(0, ...series) - low || 1;
  const y = (value: number) => 87 - (value - low) * 80 / span;
  return <>
    <label>Watched resource
      <select className="rail-analysis-key" value={current?.key ?? ""} onChange={(event) => {
        setWatched(options.find((row) => row.key === event.target.value));
      }}>
        <option value="">Choose a resource</option>
        {options.map((row) => <option key={row.key} value={row.key}>{row.displayName ?? row.resourceId}</option>)}
      </select>
    </label>
    {current ? <>
      <h2>{current.displayName ?? current.resourceId}</h2>
      <p>Net balance across edits that changed a rate.</p>
      {series.length > 1 ? <>
        <svg role="img" aria-label="Net balance across edits" viewBox="0 0 248 94">
          <line x1={4} x2={244} y1={y(0)} y2={y(0)} stroke="#757981" strokeDasharray="3 3" />
          <polyline fill="none" stroke="var(--rail-source)" strokeWidth="2" points={
            series.map((value, index) => `${4 + index * 240 / (series.length - 1)},${y(value)}`).join(" ")
          } />
        </svg>
        <dl><div><dt>First</dt><dd>{displayRate(series[0]!, current.kind)}</dd></div>
          <div><dt>Latest</dt><dd>{displayRate(series.at(-1)!, current.kind)}</dd></div></dl>
      </> : <p>Make another rate-changing edit to start the chart.</p>}
    </> : null}
  </>;
}

function Bottlenecks({ project, result, ids }: AnalysisProps) {
  const [picked, setPicked] = useState("");
  const [probe, setProbe] = useState<{ base: FactoryProject; cardId: string; result: ThroughputResult }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const scope = useMemo(() => expandPocketSelection(project, ids).itemIds, [project, ids]);
  const labels = new Map(project.nodes.map((node) => [node.id, result.nodes[node.id]?.recipeName || "Machine"]));
  const selected = project.nodes.find((node) => scope.has(node.id))?.id;
  const cardId = (labels.has(picked) ? picked : selected) ?? "";
  const plan = result.plan;
  const upTo = plan?.upTo?.[cardId];
  const reason = shownReason(upTo);
  const resource = upTo?.resourceKey ? Object.values(result.resources).find((row) => row.key === upTo.resourceKey) : undefined;
  const forced = plan?.forced.filter((entry) => entry.nodeId === cardId) ?? [];
  const shortfalls = plan?.shortfalls?.filter((entry) => !cardId || entry.limitingCards.includes(cardId)) ?? [];
  const loop = plan?.loops?.find((entry) => entry.cards.includes(cardId));
  const reading = result.nodes[cardId];
  const candidateIds = [...new Set([...(reason === "BOTTLENECK" ? [cardId] : []), ...(upTo?.upstream ?? [])])];
  const candidates = candidateIds.flatMap((id) => {
    const node = project.nodes.find((entry) => entry.id === id);
    if (!node || pinRuleOf(node) !== "upTo" || !(node.solvePin! < Number.MAX_SAFE_INTEGER)) return [];
    const wants = plan?.upTo?.[id]?.wants ?? 0;
    const count = Math.ceil(Math.max(node.solvePin! + 1, wants));
    return [{ id, count }];
  });
  const tested = probe?.base === project && probe.cardId === cardId ? probe.result : undefined;
  const next = tested?.plan?.upTo?.[cardId];
  const testCap = async (id: string, count: number) => {
    setPending(true);
    setError(false);
    const scenario = { ...project, nodes: project.nodes.map((node) =>
      node.id === id ? withPinRule(node, "upTo", count) : node,
    ) };
    try {
      setProbe({ base: project, cardId, result: await solvePreview(scenario) });
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return <>
    <label>Machine
      <select className="rail-analysis-key" value={cardId} onChange={(event) => setPicked(event.target.value)}>
        <option value="">Choose a machine</option>
        {[...labels].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
    {cardId ? <section>
      <h2>Current constraint</h2>
      {reading?.powerStalled ? <p>Insufficient power.</p> :
        loop ? <p>{loop.kind === "DEAD_LOOP" ? "Dead loop" : "Clogged loop"}</p> :
        reason ? <p>{UP_TO_WORD[reason]}{resource ? ` · ${resource.displayName ?? resource.resourceId}` : ""}. {upToSentence(upTo)}</p> :
        plan?.unanchored.includes(cardId) ? <p>Set a count or drawer rate to size this part of the plan.</p> :
        forced.length ? <p>This card uses forced flows to keep its settings.</p> :
        <p>No binding constraint reported for this card.</p>}
      {upTo?.tied?.length ? <p>{upTo.tied.length} other port{upTo.tied.length === 1 ? "" : "s"} limit it equally.</p> : null}
      {upTo?.upstream?.length ? <section><h3>Check upstream</h3>{upTo.upstream.filter((id) => labels.has(id)).map((id) =>
        <button key={id} type="button" className="rail-analysis-key" onClick={() => { setPicked(id); frameCards([id]); }}>{labels.get(id)}</button>,
      )}</section> : null}
      {candidates.length ? <section>
        <h3>Test a higher machine cap</h3>
        {candidates.map(({ id, count }) => <button key={id} type="button" className="rail-analysis-key" disabled={pending} onClick={() => void testCap(id, count)}>
          {labels.get(id)} · Up to {count}
        </button>)}
        {pending ? <p role="status">Solving with the higher cap…</p> : null}
        {error ? <p role="alert">The higher cap could not be tested.</p> : null}
        {tested ? <div role="status">
          {tested.plan?.failure || !next ? <p>Could not solve this change.</p> : <>
            <p>{formatCompact(upTo?.reached ?? 0)} → {formatCompact(next.reached)} machines running. {upToSentence(next)}</p>
            <p>{tested.plan?.unmetDrawers?.length ?? 0} unmet drawer rates after the change.</p>
          </>}
        </div> : null}
      </section> : null}
      <button type="button" className="rail-analysis-key" onClick={() => frameCards([cardId])}>Find on board</button>
    </section> : null}
    <section>
      <h3>Unmet drawer rates</h3>
      {shortfalls.length ? shortfalls.map((row) => {
        const drawer = result.storages[row.drawerId];
        return <div key={row.drawerId}>
          <button type="button" className="rail-analysis-key" onClick={() => frameCards([row.drawerId])}>{drawer?.displayName ?? drawer?.resourceId ?? "Drawer"}</button>
          {drawer ? <p>{displayRate(row.reachable, drawer.kind)} reached · {displayRate(row.target, drawer.kind)} set</p> : null}
          {row.limitingCards.filter((id) => labels.has(id)).map((id) => <button key={id} type="button" className="rail-analysis-key" onClick={() => { setPicked(id); frameCards([id]); }}>{labels.get(id)}</button>)}
        </div>;
      }) : <p>None</p>}
    </section>
  </>;
}

function Sizing({ project, result, ids }: AnalysisProps) {
  const locked = useFactoryStore((state) => state.isReadOnly || state.checklistMode);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const candidates = useMemo(() => suggestPlanSizes(
    project, result, selectedOnly ? expandPocketSelection(project, ids).itemIds : undefined,
  ), [project, result, ids, selectedOnly]);
  const apply = async () => {
    setPending(true);
    setStatus("");
    try {
      const scenario = planWithMachineSizes(project, candidates);
      const answer = await solvePreview(scenario);
      if (!verifyPlanSizes(scenario, result, answer)) {
        setStatus("These caps change the solved flows. Review the counts.");
      } else if (useFactoryStore.getState().applyPlanSizes(project, candidates)) {
        setStatus("Machine caps applied.");
      } else {
        setStatus("The plan changed. Review the new counts.");
      }
    } catch {
      setStatus("The machine caps could not be checked.");
    } finally {
      setPending(false);
    }
  };
  return <>
    <p>Round the solved machine counts up. Apply sets Up to caps after checking the plan’s flows again.</p>
    <label><input type="checkbox" checked={selectedOnly} onChange={(event) => { setSelectedOnly(event.target.checked); setStatus(""); }} /> Selected cards only</label>
    {candidates.length ? <>
      <table><thead><tr><th>Machine</th><th>Used</th><th>Up to</th></tr></thead>
        <tbody>{candidates.map((row) => <tr key={row.id}><th scope="row">{row.name}</th><td>{formatCompact(row.used)}</td><td>{row.count}</td></tr>)}</tbody>
      </table>
      <button type="button" className="rail-analysis-key" disabled={locked || pending} onClick={() => void apply()}>Apply machine caps</button>
    </> : <p>No automatic counts in this scope.</p>}
    {pending ? <p role="status">Checking machine caps…</p> : null}
    {status ? <p role="status">{status}</p> : null}
  </>;
}
