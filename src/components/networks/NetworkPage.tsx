"use client";

import "./networks.css";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Plus, RefreshCw, X } from "lucide-react";
import { useDialogA11y } from "@/lib/hooks/use-dialog-a11y";
import { useNetworkStore } from "@/store/network-store";
import { useDesignStore } from "@/store/design-store";
import { useCloudLibraryStore } from "@/lib/library/cloud-library";
import { useFactoryStore, useRateDisplayUnits } from "@/store/factory-store";
import { formatCompact } from "@/lib/model/resources";
import {
  powerDisplayFromEuT,
  powerDisplaySuffix,
  rateMultiplierForKind,
  rateSuffixForKind,
  type TimeRateUnit,
} from "@/lib/model/rate-unit";
import {
  aggregateNetworks,
  unmetDemand,
  memberKey,
  type NetworkMember,
  type PlanNetwork,
  type Sharing,
  type PlanFlows,
} from "@/lib/networks/model";
import { localDesignId, useNetworkCalculations } from "@/lib/networks/calculation";
import { syncNetworks } from "@/lib/networks/sync";
import { ResourceIcon } from "@/components/nei/ResourceIcon";
import type { MaterialFlow } from "@/lib/networks/model";

export function NetworksLibrary() {
  const catalogue = useNetworkStore((state) => state.catalogue);
  const create = useNetworkStore((state) => state.create);
  const open = useNetworkStore((state) => state.open);
  const ready = useNetworkStore((state) => state.ready);
  const [name, setName] = useState("");
  return (
    <div className="netview mx netview-library">
      <h1>Networks</h1>
      <p>Group your plans to see supply, demand and free resources.</p>
      <NetworkStatus />
      <form
        className="netview-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void create(name || "New network");
          setName("");
        }}
      >
        <input
          aria-label="New network name"
          placeholder="Network name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <button disabled={!ready}>Create network</button>
      </form>
      <div className="netview-network-list">
        {catalogue?.networks
          .filter((network) => !network.parentId)
          .map((network) => (
            <button key={network.id} onClick={() => open(network.id)}>
              <strong>{network.name}</strong>
              <span>
                {network.members.length} plans ·{" "}
                {catalogue.networks.filter((entry) => entry.parentId === network.id).length}{" "}
                subnetworks
              </span>
            </button>
          ))}
      </div>
      {ready && !catalogue?.networks.length ? (
        <p>No networks yet. Create one, then add your saved plans.</p>
      ) : null}
    </div>
  );
}

function NetworkStatus() {
  const state = useNetworkStore();
  return (
    <>
      {state.error ? (
        <p role="alert" className="netview-warning">
          {state.error}
        </p>
      ) : null}
      {state.conflict ? (
        <div className="netview-actions">
          <span>Both versions are kept until you choose.</span>
          <button onClick={() => void state.resolveConflict(true)}>Keep my changes</button>
          <button onClick={() => void state.resolveConflict(false)}>Use saved networks</button>
        </div>
      ) : state.error ? (
        <button
          onClick={() => {
            if (state.catalogue) void state.load(state.catalogue.account).then(syncNetworks);
          }}
        >
          Reload networks
        </button>
      ) : null}
    </>
  );
}

export function NetworkPage() {
  const catalogue = useNetworkStore((state) => state.catalogue);
  const activeId = useNetworkStore((state) => state.activeId);
  const edit = useNetworkStore((state) => state.edit);
  const open = useNetworkStore((state) => state.open);
  const create = useNetworkStore((state) => state.create);
  const remove = useNetworkStore((state) => state.remove);
  const designs = useDesignStore((state) => state.designs);
  const shared = useCloudLibraryStore((state) => state.shared);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [planQuery, setPlanQuery] = useState("");
  const [armed, setArmed] = useState(false);
  const [editingPorts, setEditingPorts] = useState<string>();
  // Display dials repaint this view without invalidating its calculations.
  useRateDisplayUnits();
  const flows = useNetworkCalculations(retry);
  const networks = catalogue?.networks ?? [];
  const balances = useMemo(
    () => aggregateNetworks(catalogue?.networks ?? [], flows),
    [catalogue?.networks, flows],
  );
  const network = networks.find((entry) => entry.id === activeId);
  const balance = activeId ? balances.get(activeId) : undefined;
  if (!network || !balance) return <NetworksLibrary />;
  const patch = (values: Partial<PlanNetwork>) =>
    void edit((entries) =>
      entries.map((entry) => (entry.id === network.id ? { ...entry, ...values } : entry)),
    );
  const openMember = async (member: NetworkMember) => {
    useNetworkStore.getState().leave();
    if (member.ownerId) {
      const remote = shared?.find(
        (entry) => entry.id === member.designId && entry.ownerId === member.ownerId,
      );
      if (remote)
        await useDesignStore
          .getState()
          .openSharedDesign(
            { ownerId: member.ownerId, designId: member.designId, ownerName: remote.ownerName },
            remote.name,
          );
    } else await useDesignStore.getState().switchToDesign(member.designId);
  };
  const choices: NetworkMember[] = [
    ...designs
      .filter((entry) => !entry.taskBoard && !entry.cloud)
      .map((entry) => ({ designId: entry.id, name: entry.name, included: true })),
    ...(shared ?? []).map((entry) => ({
      designId: entry.id,
      ownerId: entry.ownerId,
      name: `${entry.name} (${entry.ownerName})`.slice(0, 80),
      included: true,
    })),
  ];
  const excludedAncestor = (() => {
    let entry: PlanNetwork | undefined = network;
    while (entry) {
      if (!entry.included) return true;
      entry = networks.find((next) => next.id === entry?.parentId);
    }
    return false;
  })();
  return (
    <div className="netview mx" data-network-page="">
      <header className="netview-header">
        <div>
          <span className="netview-kicker">{network.parentId ? "Subnetwork" : "Network"}</span>
          <input
            key={network.id}
            className="netview-title"
            aria-label="Network name"
            defaultValue={network.name}
            maxLength={80}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== network.name) patch({ name });
              else event.target.value = network.name;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
        <div className="netview-actions">
          <NetworkRateControl />
          <button
            className="netview-icon-button"
            aria-label="Refresh figures"
            title="Refresh figures"
            onClick={() => {
              setRetry((value) => value + 1);
              void syncNetworks();
            }}
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <NetworkStatus />
      <div className="netview-layout">
        <aside className="netview-members" aria-label="Network members">
          <div className="netview-section-title">
            Networks
            <button
              className="netview-icon-button"
              aria-label="New subnetwork"
              title="New subnetwork"
              onClick={() => void create("New subnetwork", network.id)}
            >
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
          <NetworkTree networks={networks} />
          <div className="netview-section-title">
            Plans in {network.name}
            <button
              className="netview-icon-button"
              aria-label="Add plans"
              title="Add plans"
              onClick={() => setAdding(!adding)}
            >
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
          <PlanGroups
            members={network.members}
            onMove={(key, group) =>
              patch({
                members: network.members.map((member) =>
                  memberKey(member) === key ? { ...member, group } : member,
                ),
              })
            }
            renderMember={(member) => (
              <div className="netview-member" key={memberKey(member)}>
                <span
                  className="netview-drag-handle"
                  title="Drag to another plan group"
                  aria-hidden="true"
                >
                  <GripVertical size={14} />
                </span>
                <label title="Include in totals">
                  <input
                    type="checkbox"
                    aria-label={`Include ${member.name}`}
                    checked={member.included}
                    onChange={(event) =>
                      patch({
                        members: network.members.map((entry) =>
                          memberKey(entry) === memberKey(member)
                            ? { ...entry, included: event.target.checked }
                            : entry,
                        ),
                      })
                    }
                  />
                </label>
                <button className="netview-link" onClick={() => void openMember(member)}>
                  {designs.find((entry) => entry.id === localDesignId(member))?.name ?? member.name}
                </button>
                <button
                  aria-label={`Inputs and outputs for ${member.name}`}
                  onClick={() => setEditingPorts(memberKey(member))}
                >
                  I/O
                </button>
                <button
                  aria-label={`Remove ${member.name}`}
                  onClick={() =>
                    patch({
                      members: network.members.filter(
                        (entry) => memberKey(entry) !== memberKey(member),
                      ),
                    })
                  }
                >
                  ×
                </button>
              </div>
            )}
          />
          {!network.members.length ? <p>Add saved plans to start counting their flows.</p> : null}
          <label className="netview-field">
            Parent network
            <select
              aria-label="Parent network"
              value={network.parentId ?? ""}
              onChange={(event) => patch({ parentId: event.target.value || undefined })}
            >
              <option value="">None</option>
              {networks
                .filter(
                  (entry) => entry.id !== network.id && !isDescendant(entry, network.id, networks),
                )
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="netview-check">
            <input
              type="checkbox"
              checked={network.included}
              onChange={(event) => patch({ included: event.target.checked })}
            />
            Include in parent totals
          </label>
          {armed ? (
            <div>
              <p>Delete this network? Plans are kept. Subnetworks move to its parent.</p>
              <button className="netview-danger" onClick={() => void remove(network.id)}>
                Delete network
              </button>{" "}
              <button onClick={() => setArmed(false)}>Cancel</button>
            </div>
          ) : (
            <button onClick={() => setArmed(true)}>Delete network…</button>
          )}
        </aside>
        <main className="netview-ledger">
          {network.members
            .filter((member) => memberKey(member) === editingPorts)
            .map((member) => (
              <PortPicker
                key={editingPorts}
                member={member}
                flow={flows.get(memberKey(member))}
                groups={[
                  ...new Set(
                    network.members.flatMap((entry) => (entry.group ? [entry.group] : [])),
                  ),
                ]}
                onGroupChange={(group) =>
                  patch({
                    members: network.members.map((entry) =>
                      memberKey(entry) === memberKey(member) ? { ...entry, group } : entry,
                    ),
                  })
                }
                onDone={() => setEditingPorts(undefined)}
                onChange={(portSelection) =>
                  patch({
                    members: network.members.map((entry) =>
                      memberKey(entry) === memberKey(member) ? { ...entry, portSelection } : entry,
                    ),
                  })
                }
              />
            ))}
          {adding ? (
            <section className="netview-picker" aria-label="Add plans">
              <div className="netview-actions">
                <input
                  aria-label="Find plans to add"
                  placeholder="Find a plan"
                  value={planQuery}
                  onChange={(event) => setPlanQuery(event.target.value)}
                />
                <button onClick={() => setAdding(false)}>Done</button>
              </div>
              <div className="netview-choices">
                {choices
                  .filter((entry) => entry.name.toLowerCase().includes(planQuery.toLowerCase()))
                  .map((member) => {
                    const current = networks.find((entry) =>
                      entry.members.some((plan) => memberKey(plan) === memberKey(member)),
                    );
                    return (
                      <div className="netview-member" key={memberKey(member)}>
                        <span>{member.name}</span>
                        <button
                          disabled={current?.id === network.id}
                          onClick={() =>
                            void useNetworkStore.getState().addMember(network.id, member)
                          }
                        >
                          {current?.id === network.id
                            ? "Added"
                            : current
                              ? `Move from ${current.name}`
                              : "Add"}
                        </button>
                      </div>
                    );
                  })}
              </div>
              {!choices.length ? <p>Create a plan first, then add it here.</p> : null}
            </section>
          ) : null}
          {excludedAncestor ? (
            <p className="netview-warning">
              Excluded from ancestor totals. Figures below describe this network on its own.
            </p>
          ) : null}
          {balance.incomplete.length ? (
            <details className="netview-warning" open>
              <summary>Figures incomplete · {balance.incomplete.length} members</summary>
              {balance.incomplete.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
            </details>
          ) : null}
          <div className="netview-power">
            <span>
              Power used{" "}
              <strong>
                {formatCompact(powerDisplayFromEuT(balance.power.used))} {powerDisplaySuffix()}
              </strong>
            </span>
            <span>
              Power generated{" "}
              <strong>
                {formatCompact(powerDisplayFromEuT(balance.power.made))} {powerDisplaySuffix()}
              </strong>
            </span>
          </div>
          <div className="netview-actions">
            <input
              aria-label="Find a resource"
              placeholder="Find a resource"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span>Rates follow each plan’s settings.</span>
          </div>
          {network.parentId ? (
            <p className="netview-hint">
              From parent is the supply needed. A parent shortage is not allocated between plans.
            </p>
          ) : null}
          <div className="netview-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Supply</th>
                  <th>Demand</th>
                  <th>Free</th>
                  <th>Shortage</th>
                  {network.parentId ? (
                    <>
                      <th>From parent</th>
                      <th>To parent</th>
                      <th>Sharing</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {balance.resources
                  .filter((row) => row.label.toLowerCase().includes(query.toLowerCase()))
                  .map((row) => {
                    const rate = (value: number) =>
                      `${formatCompact(value * rateMultiplierForKind(row.kind))}${rateSuffixForKind(row.kind)}`;
                    const expand = expanded.has(row.key);
                    const unmet = unmetDemand(networks, balances, network.id, row.key);
                    const parentShort = row.fromParent > 0 && unmet === undefined;
                    return (
                      <ResourceRows key={row.key}>
                        <tr>
                          <th>
                            <button
                              className="netview-link"
                              aria-expanded={expand}
                              onClick={() =>
                                setExpanded((previous) => {
                                  const next = new Set(previous);
                                  if (expand) next.delete(row.key);
                                  else next.add(row.key);
                                  return next;
                                })
                              }
                            >
                              <span className="netview-resource">
                                <span aria-hidden>{expand ? "▾" : "▸"}</span>
                                <NetworkResourceIcon flow={row} />
                                <span>{row.label}</span>
                              </span>
                            </button>
                          </th>
                          <td>{rate(row.supply)}</td>
                          <td>{rate(row.demand)}</td>
                          <td className={row.free ? "netview-free" : ""}>{rate(row.free)}</td>
                          <td className={unmet !== 0 ? "netview-short" : ""}>
                            {unmet === undefined ? "Unallocated" : rate(unmet)}
                          </td>
                          {network.parentId ? (
                            <>
                              <td className={row.fromParent && parentShort ? "netview-short" : ""}>
                                {rate(row.fromParent)}
                                {row.fromParent && parentShort ? (
                                  <span className="netview-note">Parent shortage</span>
                                ) : null}
                              </td>
                              <td>{rate(row.toParent)}</td>
                              <td>
                                <select
                                  aria-label={`Sharing for ${row.label}`}
                                  value={network.sharing[row.key] ?? "internal"}
                                  onChange={(event) =>
                                    patch({
                                      sharing: {
                                        ...network.sharing,
                                        [row.key]: event.target.value as Sharing,
                                      },
                                    })
                                  }
                                >
                                  <option value="internal">Internal</option>
                                  <option value="import">Import</option>
                                  <option value="export">Export</option>
                                  <option value="both">Both</option>
                                </select>
                              </td>
                            </>
                          ) : null}
                        </tr>
                        {expand
                          ? row.contributions.map((entry) => (
                              <tr className="netview-contribution" key={entry.id}>
                                <th>
                                  <button
                                    className="netview-link"
                                    onClick={() => {
                                      if (entry.network) open(entry.id);
                                      else {
                                        const member = network.members.find(
                                          (candidate) => memberKey(candidate) === entry.id,
                                        );
                                        if (member) void openMember(member);
                                      }
                                    }}
                                  >
                                    {entry.name}
                                  </button>
                                </th>
                                <td>{rate(entry.supply)}</td>
                                <td>{rate(entry.demand)}</td>
                                <td colSpan={network.parentId ? 5 : 2} />
                              </tr>
                            ))
                          : null}
                      </ResourceRows>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {!balance.resources.length ? (
            <p>No boundary flows yet. Add plans with inputs or collected outputs.</p>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function ResourceRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function PortPicker({
  member,
  flow,
  groups,
  onGroupChange,
  onChange,
  onDone,
}: {
  member: NetworkMember;
  flow?: PlanFlows;
  groups: string[];
  onGroupChange: (group: string | undefined) => void;
  onChange: (selection: string[] | undefined) => void;
  onDone: () => void;
}) {
  useRateDisplayUnits();
  const ports = flow?.ports ?? [];
  const keys = [...new Set(ports.map((port) => port.portKey))];
  const selected = new Set(member.portSelection ?? keys);
  const machines = [...new Set(ports.map((port) => port.machine))];
  const toggle = (key: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    onChange([...next]);
  };
  return (
    <NetworkModal title={`Inputs and outputs · ${member.name}`} onClose={onDone}>
      <label className="netview-group-field">
        Plan group
        <input
          aria-label="Plan group"
          placeholder="Ungrouped"
          list="network-plan-groups"
          defaultValue={member.group ?? ""}
          maxLength={80}
          onBlur={(event) => {
            const group = event.target.value.trim() || undefined;
            if (group !== member.group) onGroupChange(group);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <datalist id="network-plan-groups">
          {groups.map((group) => (
            <option key={group} value={group} />
          ))}
        </datalist>
      </label>
      <div className="netview-actions">
        <NetworkRateControl />
        <button onClick={() => onChange(undefined)}>Use all ports</button>
        <button onClick={() => onChange([])}>Clear all</button>
        <button onClick={onDone}>Done</button>
      </div>
      <p>
        Choose which machine ports count toward this network. Only flows entering or leaving the
        plan count. Drawers are optional.
      </p>
      {flow?.error || !flow ? <p>{flow?.error ?? "Calculating ports…"}</p> : null}
      <div className="netview-port-list">
        {machines.map((machine) => (
          <fieldset key={machine}>
            <legend>{machine}</legend>
            {ports
              .filter((port) => port.machine === machine)
              .map((port) => (
                <label className="netview-port" key={JSON.stringify([port.portKey, port.key])}>
                  <input
                    type="checkbox"
                    checked={selected.has(port.portKey)}
                    onChange={(event) => toggle(port.portKey, event.target.checked)}
                  />
                  <NetworkResourceIcon flow={port} />
                  <span>
                    {port.side === "in" ? "Input" : "Output"} · {port.label}
                  </span>
                  <span>
                    {formatCompact((port.supply + port.demand) * rateMultiplierForKind(port.kind))}
                    {rateSuffixForKind(port.kind)}
                  </span>
                </label>
              ))}
          </fieldset>
        ))}
        {(member.portSelection ?? [])
          .filter((key) => !keys.includes(key))
          .map((key) => (
            <label className="netview-port" key={key}>
              <input type="checkbox" checked onChange={() => toggle(key, false)} />
              <span>Unavailable port</span>
            </label>
          ))}
      </div>
    </NetworkModal>
  );
}

function PlanGroups({
  members,
  renderMember,
  onMove,
}: {
  members: NetworkMember[];
  renderMember: (member: NetworkMember) => React.ReactNode;
  onMove: (key: string, group: string | undefined) => void;
}) {
  const [dragged, setDragged] = useState<string>();
  const dragKey = useRef<string>(undefined);
  const [over, setOver] = useState<string>();
  const finish = () => {
    dragKey.current = undefined;
    setDragged(undefined);
    setOver(undefined);
  };
  const render = (member: NetworkMember) => (
    <div
      key={memberKey(member)}
      className="netview-draggable-plan"
      role="group"
      aria-label={`Draggable plan ${member.name}`}
      draggable
      data-dragging={dragged === memberKey(member) ? "" : undefined}
      onDragStart={(event) => {
        const key = memberKey(member);
        event.dataTransfer.setData("application/x-gtnh-network-plan", key);
        event.dataTransfer.effectAllowed = "move";
        dragKey.current = key;
        setDragged(key);
      }}
      onDragEnd={finish}
    >
      {renderMember(member)}
    </div>
  );
  const groups = [
    ...new Set(members.flatMap((member) => (member.group ? [member.group] : []))),
  ].sort((a, b) => a.localeCompare(b));
  if (!groups.length) return <>{members.map(render)}</>;
  return (
    <>
      {[...groups, undefined].map((group) => {
        const plans = members.filter((member) => member.group === group);
        return (
          <details
            className="netview-plan-group"
            key={group ?? ""}
            open
            data-drop-target={over === (group ?? "") ? "" : undefined}
            onDragEnter={(event) => {
              if (!dragKey.current) return;
              event.preventDefault();
              setOver(group ?? "");
            }}
            onDragOver={(event) => {
              if (!dragKey.current) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOver(group ?? "");
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setOver(undefined);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const key = event.dataTransfer.getData("application/x-gtnh-network-plan");
              const member = members.find((entry) => memberKey(entry) === key);
              if (key === dragKey.current && member && member.group !== group) onMove(key, group);
              finish();
            }}
          >
            <summary>
              {group ?? "Ungrouped"} <span>{plans.length}</span>
            </summary>
            {plans.map(render)}
            {!plans.length ? <p className="netview-drop-hint">Drop a plan here</p> : null}
          </details>
        );
      })}
    </>
  );
}

function NetworkRateControl() {
  const unit = useFactoryStore((state) => state.rateUnit);
  const setUnit = useFactoryStore((state) => state.setRateUnit);
  return (
    <select
      aria-label="Rate unit"
      title="Rate unit"
      value={unit === "eu" ? "second" : unit}
      onChange={(event) => setUnit(event.target.value as TimeRateUnit)}
    >
      <option value="tick">/t</option>
      <option value="second">/s</option>
      <option value="minute">/min</option>
      <option value="hour">/hr</option>
    </select>
  );
}

function NetworkModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y(ref, { onClose });
  return createPortal(
    <div
      className="netview-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="netview mx netview-modal ui-zoom"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="netview-modal-title">
          <strong>{title}</strong>
          <button className="netview-icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function NetworkResourceIcon({ flow }: { flow: MaterialFlow }) {
  return (
    <span aria-hidden="true" className="netview-resource-icon">
      <ResourceIcon
        resource={{
          kind: flow.kind,
          id: flow.resourceId,
          displayName: flow.label,
          amount: 1,
          iconPath: flow.iconPath,
          iconAtlas: flow.iconAtlas,
          dominantColor: flow.dominantColor,
        }}
        bare
        showAmount={false}
        tooltip={false}
        showConsumedState={false}
        className="!h-5 !w-5"
        iconPixelSize={20}
      />
    </span>
  );
}

function isDescendant(network: PlanNetwork, ancestor: string, networks: PlanNetwork[]): boolean {
  let parent = network.parentId;
  while (parent) {
    if (parent === ancestor) return true;
    parent = networks.find((entry) => entry.id === parent)?.parentId;
  }
  return false;
}

function NetworkTree({ networks, parentId }: { networks: PlanNetwork[]; parentId?: string }) {
  const activeId = useNetworkStore((state) => state.activeId);
  return (
    <ul className="netview-tree">
      {networks
        .filter((network) => network.parentId === parentId)
        .map((network) => (
          <li key={network.id}>
            <button
              className="netview-link"
              aria-current={activeId === network.id ? "page" : undefined}
              onClick={() => useNetworkStore.getState().open(network.id)}
            >
              {network.name}
              {!network.included ? " (excluded)" : ""}
            </button>
            <NetworkTree networks={networks} parentId={network.id} />
          </li>
        ))}
    </ul>
  );
}
