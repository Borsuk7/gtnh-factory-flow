"use client";

import "./networks.css";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRightLeft,
  ChevronRight,
  CircleHelp,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  ChromeMenu,
  chromeAnchorOf,
  MENU_ANCHOR_ATTR,
  type ChromeAnchor,
  type MenuEntry,
} from "@/components/chrome/ChromeMenu";
import { useDialogA11y } from "@/lib/hooks/use-dialog-a11y";
import {
  readDeviceSettings,
  useDeviceSettings,
  wheelChangesValues,
  writeDeviceSettings,
} from "@/lib/device-settings";
import { PanelHandle } from "@/components/PanelHandle";
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

function NetworkSaveStatus({ updating }: { updating: boolean }) {
  const { ready, saving, syncing, catalogue, error, conflict } = useNetworkStore();
  const message = !ready
    ? "Loading networks…"
    : error || conflict
      ? "Changes need attention"
      : saving
        ? "Saving…"
        : syncing
          ? "Syncing…"
          : catalogue?.account === "local"
            ? "Saved locally"
            : catalogue?.dirty
              ? "Saved locally · Sync pending"
              : "Synced";
  return (
    <span className="netview-save-status" role="status">
      {message}
      {updating ? " · Updating figures…" : ""}
    </span>
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
  const [resourceFilter, setResourceFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [planQuery, setPlanQuery] = useState("");
  const [armed, setArmed] = useState<string>();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [renamingGroup, setRenamingGroup] = useState<string>();
  const [editingPorts, setEditingPorts] = useState<string>();
  const layoutRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const { networkSidebarWidth } = useDeviceSettings();
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
  const groupNames = [
    ...new Set([
      ...(network.groups ?? []),
      ...network.members.flatMap((member) => (member.group ? [member.group] : [])),
    ]),
  ].sort((a, b) => a.localeCompare(b));
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
  const filteredChoices = choices.filter((entry) =>
    entry.name.toLowerCase().includes(planQuery.toLowerCase()),
  );
  const updating = networks.some((entry) =>
    entry.members.some(
      (member) =>
        member.included && (!flows.has(memberKey(member)) || flows.get(memberKey(member))?.stale),
    ),
  );
  const shortageCount = balance.resources.filter(
    (row) => unmetDemand(networks, balances, network.id, row.key) !== 0,
  ).length;
  const filter = !network.parentId && resourceFilter === "parent" ? "all" : resourceFilter;
  const filteredResources = balance.resources.filter((row) => {
    if (!row.label.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === "shortages") return unmetDemand(networks, balances, network.id, row.key) !== 0;
    if (filter === "available") return row.free > 0;
    if (filter === "parent") return row.fromParent > 0 || row.toParent > 0;
    return true;
  });
  const excludedAncestor = (() => {
    let entry: PlanNetwork | undefined = network;
    while (entry) {
      if (entry.parentId && !entry.included) return true;
      entry = networks.find((next) => next.id === entry?.parentId);
    }
    return false;
  })();
  return (
    <div className="netview mx netview-page" data-network-page="">
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
          <NetworkSaveStatus updating={updating} />
          <NetworkRateControl />
          <button
            className="netview-danger netview-icon-button"
            aria-label="Delete network"
            title="Delete network"
            onClick={() => setArmed(network.id)}
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
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
      <div
        className="netview-layout"
        ref={layoutRef}
        style={{ "--network-sidebar-width": `${networkSidebarWidth}px` } as CSSProperties}
      >
        <aside className="netview-members" aria-label="Network members" ref={sidebarRef}>
          <div className="netview-members-scroll">
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
              <span>Plans in {network.name}</span>
              <div className="netview-section-actions">
                <button
                  className="netview-icon-button"
                  aria-label="New group"
                  title="New group"
                  onClick={() => {
                    setRenamingGroup(undefined);
                    setGroupName("");
                    setCreatingGroup(true);
                  }}
                >
                  <FolderPlus size={18} aria-hidden="true" />
                </button>
                <button
                  className="netview-icon-button"
                  aria-label="Add plans"
                  title="Add plans"
                  onClick={() => setAdding(!adding)}
                >
                  <Plus size={18} aria-hidden="true" />
                </button>
              </div>
            </div>
            <PlanGroups
              members={network.members}
              groups={groupNames}
              onRenameGroup={(group) => {
                setRenamingGroup(group);
                setGroupName(group);
                setCreatingGroup(true);
              }}
              onRemoveGroup={(group) =>
                patch({
                  groups: groupNames.filter((name) => name !== group),
                  members: network.members.map((member) =>
                    member.group === group ? { ...member, group: undefined } : member,
                  ),
                })
              }
              onMove={(key, group) =>
                patch({
                  groups: groupNames,
                  members: network.members.map((member) =>
                    memberKey(member) === key ? { ...member, group } : member,
                  ),
                })
              }
              renderMember={(member) => (
                <div className="netview-member netview-member-plan" key={memberKey(member)}>
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
                  <button
                    className="netview-link netview-plan-name"
                    title={
                      designs.find((entry) => entry.id === localDesignId(member))?.name ??
                      member.name
                    }
                    onClick={() => void openMember(member)}
                  >
                    {designs.find((entry) => entry.id === localDesignId(member))?.name ??
                      member.name}
                  </button>
                  <OverflowMenu
                    label={`Options for ${member.name}`}
                    entries={[
                      {
                        label: "Inputs and outputs",
                        onSelect: () => setEditingPorts(memberKey(member)),
                      },
                      {
                        label: "Remove from network",
                        detail: "plan is kept",
                        tone: "red",
                        onSelect: () =>
                          patch({
                            members: network.members.filter(
                              (entry) => memberKey(entry) !== memberKey(member),
                            ),
                          }),
                      },
                    ]}
                  />
                  <button
                    className="netview-plan-io"
                    aria-label={`Inputs and outputs for ${member.name}`}
                    title="Inputs and outputs"
                    onClick={() => setEditingPorts(memberKey(member))}
                  >
                    <ArrowRightLeft size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
            />
            {!network.members.length ? <p>Add saved plans to start counting their flows.</p> : null}
            <details className="netview-settings" key={network.id}>
              <summary>Network settings</summary>
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
                      (entry) =>
                        entry.id !== network.id && !isDescendant(entry, network.id, networks),
                    )
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                </select>
              </label>
              {network.parentId ? (
                <label className="netview-check">
                  <input
                    type="checkbox"
                    checked={network.included}
                    onChange={(event) => patch({ included: event.target.checked })}
                  />
                  Include in parent totals
                </label>
              ) : null}
              {network.parentId ? (
                <div>
                  <label className="netview-check">
                    <input
                      type="checkbox"
                      checked={network.selfPowered ?? false}
                      onChange={(event) => patch({ selfPowered: event.target.checked })}
                      aria-describedby="network-self-powered-help"
                    />
                    Self-powered
                  </label>
                  <p className="netview-note" id="network-self-powered-help">
                    Keep this subnetwork’s power out of parent totals.
                  </p>
                </div>
              ) : null}
            </details>
          </div>
          <PanelHandle
            label="Resize network plan list"
            edge="right"
            getWidth={() => sidebarRef.current?.offsetWidth || networkSidebarWidth}
            getLimits={() => ({
              min: 240,
              max: Math.max(240, Math.min(640, (layoutRef.current?.clientWidth || 1280) / 2)),
            })}
            onDrag={(width) =>
              layoutRef.current?.style.setProperty("--network-sidebar-width", `${width}px`)
            }
            onCommit={(width) => writeDeviceSettings({ networkSidebarWidth: width })}
            onReset={() => writeDeviceSettings({ networkSidebarWidth: 300 })}
            onEnd={() =>
              layoutRef.current?.style.setProperty(
                "--network-sidebar-width",
                `${readDeviceSettings().networkSidebarWidth}px`,
              )
            }
          />
        </aside>
        <main className="netview-ledger">
          {network.members
            .filter((member) => memberKey(member) === editingPorts)
            .map((member) => (
              <PortPicker
                key={editingPorts}
                member={member}
                flow={flows.get(memberKey(member))}
                groups={groupNames}
                onGroupChange={(group) =>
                  patch({
                    groups: [...new Set([...groupNames, ...(group ? [group] : [])])],
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
            <NetworkModal title="Add plans" initialFocus="input" onClose={() => setAdding(false)}>
              <div className="netview-actions">
                <input
                  aria-label="Find plans to add"
                  placeholder="Find a plan"
                  value={planQuery}
                  onChange={(event) => setPlanQuery(event.target.value)}
                />
              </div>
              <div className="netview-choices">
                {filteredChoices.map((member) => {
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
              {choices.length > 0 && !filteredChoices.length ? (
                <p>No plans match your search.</p>
              ) : null}
            </NetworkModal>
          ) : null}
          {creatingGroup ? (
            <NetworkModal
              title={renamingGroup ? "Rename group" : "New group"}
              initialFocus="input"
              onClose={() => setCreatingGroup(false)}
            >
              <form
                className="netview-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = groupName.trim();
                  if (!name) return;
                  if (name !== renamingGroup && groupNames.includes(name)) return;
                  patch({
                    groups: [
                      ...new Set([
                        ...groupNames.map((group) => (group === renamingGroup ? name : group)),
                        name,
                      ]),
                    ],
                    ...(renamingGroup
                      ? {
                          members: network.members.map((member) =>
                            member.group === renamingGroup ? { ...member, group: name } : member,
                          ),
                        }
                      : {}),
                  });
                  setCreatingGroup(false);
                }}
              >
                <input
                  aria-label="Group name"
                  placeholder="Group name"
                  maxLength={80}
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                />
                <button
                  disabled={
                    !groupName.trim() ||
                    (groupName.trim() !== renamingGroup && groupNames.includes(groupName.trim()))
                  }
                >
                  {renamingGroup ? "Save name" : "Create group"}
                </button>
              </form>
              <p>Drag plans into the group, or choose it in a plan’s I/O settings.</p>
            </NetworkModal>
          ) : null}
          {armed === network.id ? (
            <NetworkModal title={`Delete ${network.name}?`} onClose={() => setArmed(undefined)}>
              <p>Plans are kept. Subnetworks move to this network’s parent.</p>
              <div className="netview-actions">
                <button onClick={() => setArmed(undefined)}>Cancel</button>
                <button className="netview-danger" onClick={() => void remove(network.id)}>
                  Delete network
                </button>
              </div>
            </NetworkModal>
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
            {network.parentId && network.selfPowered ? <SelfPoweredIcon /> : null}
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
            {shortageCount > 0 ? (
              <button
                className="netview-shortage-count"
                onClick={() => setResourceFilter("shortages")}
              >
                {shortageCount} {shortageCount === 1 ? "resource short" : "resources short"}
              </button>
            ) : null}
          </div>
          <div className="netview-filters" role="group" aria-label="Resource filters">
            {[
              ["all", "All"],
              ["shortages", "Shortages"],
              ["available", "Available"],
              ...(network.parentId ? [["parent", "Parent connections"]] : []),
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setResourceFilter(value!)}
              >
                {label}
              </button>
            ))}
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
                  <th
                    title={
                      network.parentId
                        ? "Surplus after this subnetwork’s own demand, before consumption elsewhere in the parent."
                        : "Surplus after included plans and shared subnet flows."
                    }
                  >
                    {network.parentId ? "Local surplus" : "Free"}
                  </th>
                  <th>Shortage</th>
                  {network.parentId ? (
                    <>
                      <th title="Requested import from the parent, not a reserved allocation.">
                        From parent
                      </th>
                      <th title="Surplus offered to the parent. Other plans may consume it there.">
                        To parent
                      </th>
                      <th>Sharing</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {filteredResources.map((row) => {
                  const rate = (value: number) =>
                    `${formatCompact(value * rateMultiplierForKind(row.kind))}${rateSuffixForKind(row.kind)}`;
                  const expand = expanded.has(row.key);
                  const unmet = unmetDemand(networks, balances, network.id, row.key);
                  const parentShort = row.fromParent > 0 && unmet === undefined;
                  return (
                    <ResourceRows key={row.key}>
                      <tr>
                        <th className="netview-resource-cell">
                          <button
                            className="netview-link netview-resource-toggle"
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
                              <WheelSelect
                                aria-label={`Sharing for ${row.label}`}
                                title={sharingDescription[network.sharing[row.key] ?? "internal"]}
                                value={network.sharing[row.key] ?? "internal"}
                                onValueChange={(value) =>
                                  patch({
                                    sharing: {
                                      ...network.sharing,
                                      [row.key]: value as Sharing,
                                    },
                                  })
                                }
                              >
                                <option value="internal">Internal</option>
                                <option value="import">Import</option>
                                <option value="export">Export</option>
                                <option value="both">Both</option>
                              </WheelSelect>
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
                {!filteredResources.length ? (
                  <tr>
                    <td className="netview-empty" colSpan={network.parentId ? 8 : 5}>
                      {balance.resources.length
                        ? "No resources match this view."
                        : updating
                          ? "Updating figures…"
                          : "No boundary flows yet. Add plans with inputs or collected outputs."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}

function ResourceRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const sharingDescription: Record<Sharing, string> = {
  internal: "Internal: no resources cross the parent boundary",
  import: "Import from parent: request missing resources",
  export: "Export to parent: share surplus resources",
  both: "Both directions: import shortages and export surplus",
};

function SelfPoweredIcon() {
  return (
    <span
      className="netview-self-powered"
      role="img"
      aria-label="Self-powered"
      title="Self-powered: power excluded from parent totals"
    >
      <Zap size={16} aria-hidden="true" />
    </span>
  );
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
  const [showHelp, setShowHelp] = useState(false);
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
    <NetworkModal
      title={`Inputs and outputs · ${member.name}`}
      onClose={onDone}
      initialFocus='button[aria-label="Close"]'
      actions={
        <button
          className="netview-icon-button"
          aria-label="About network ports"
          aria-expanded={showHelp}
          aria-controls="network-port-help"
          title="About network ports"
          onClick={() => setShowHelp((value) => !value)}
        >
          <CircleHelp size={18} aria-hidden="true" />
        </button>
      }
    >
      <div className="netview-port-toolbar">
        <label className="netview-group-field">
          Plan group
          <select
            aria-label="Plan group"
            value={member.group ?? ""}
            onChange={(event) => onGroupChange(event.target.value || undefined)}
          >
            <option value="">Ungrouped</option>
            {groups.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        </label>
        <NetworkRateControl />
        <button onClick={() => onChange(undefined)}>Use all ports</button>
        <button onClick={() => onChange([])}>Clear all</button>
      </div>
      <p id="network-port-help" hidden={!showHelp}>
        Choose which machine ports count toward this network. Only flows entering or leaving the
        plan count. Drawers are optional.
      </p>
      {flow?.error || !flow ? <p>{flow?.error ?? "Calculating ports…"}</p> : null}
      <div className="netview-port-list">
        {machines.map((machine, index) => {
          const machinePorts = ports.filter((port) => port.machine === machine);
          // Several resource rows may describe one port; selection acts on the port key.
          const machineKeys = [...new Set(machinePorts.map((port) => port.portKey))];
          const selectedCount = machineKeys.filter((key) => selected.has(key)).length;
          return (
            <details className="netview-port-machine" key={machine} open={index === 0}>
              <summary>
                <ChevronRight className="netview-port-chevron" size={16} aria-hidden="true" />
                <span className="netview-port-machine-name">{machine}</span>
                <span className="netview-port-count" aria-live="polite">
                  {selectedCount}/{machineKeys.length}
                  <span className="netview-port-count-word"> selected</span>
                </span>
              </summary>
              <div className="netview-machine-ports">
                {machinePorts.map((port) => (
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
                      {formatCompact(
                        (port.supply + port.demand) * rateMultiplierForKind(port.kind),
                      )}
                      {rateSuffixForKind(port.kind)}
                    </span>
                  </label>
                ))}
              </div>
            </details>
          );
        })}
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
  groups,
  renderMember,
  onMove,
  onRemoveGroup,
  onRenameGroup,
}: {
  members: NetworkMember[];
  groups: string[];
  renderMember: (member: NetworkMember) => React.ReactNode;
  onMove: (key: string, group: string | undefined) => void;
  onRemoveGroup: (group: string) => void;
  onRenameGroup: (group: string) => void;
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
  if (!groups.length) return <>{members.map(render)}</>;
  return (
    <>
      {[...groups, undefined].map((group) => {
        const plans = members.filter((member) => member.group === group);
        if (!group && !plans.length && !dragged) return null;
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
              <span className="netview-group-caption">
                <span className="netview-group-name">{group ?? "Ungrouped"}</span>{" "}
                <span className="netview-group-count">{plans.length}</span>
                {group ? (
                  <OverflowMenu
                    label={`Options for group ${group}`}
                    entries={[
                      { label: "Rename group", onSelect: () => onRenameGroup(group) },
                      {
                        label: "Delete group",
                        detail: "plans become Ungrouped",
                        tone: "red",
                        onSelect: () => onRemoveGroup(group),
                      },
                    ]}
                  />
                ) : null}
              </span>
            </summary>
            {plans.map(render)}
            {!plans.length && (group || dragged) ? (
              <p className="netview-drop-hint">Drop a plan here</p>
            ) : null}
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
    <WheelSelect
      aria-label="Rate unit"
      title="Rate unit"
      value={unit === "eu" ? "second" : unit}
      onValueChange={(value) => setUnit(value as TimeRateUnit)}
    >
      <option value="tick">/t</option>
      <option value="second">/s</option>
      <option value="minute">/min</option>
      <option value="hour">/hr</option>
    </WheelSelect>
  );
}

function WheelSelect({
  onValueChange,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
  onValueChange: (value: string) => void;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const select = ref.current;
    if (!select) return;
    const wheel = (event: WheelEvent) => {
      if (!wheelChangesValues() || !event.deltaY || select.disabled || event.ctrlKey) return;
      // A native, non-passive listener keeps a value change from also scrolling the ledger.
      event.preventDefault();
      event.stopPropagation();
      const index = select.selectedIndex;
      const next = Math.max(
        0,
        Math.min(select.options.length - 1, index + (event.deltaY < 0 ? 1 : -1)),
      );
      if (next !== index) onValueChange(select.options[next]!.value);
    };
    select.addEventListener("wheel", wheel, { passive: false });
    return () => select.removeEventListener("wheel", wheel);
  }, [onValueChange]);
  return <select {...props} ref={ref} onChange={(event) => onValueChange(event.target.value)} />;
}

function OverflowMenu({ label, entries }: { label: string; entries: MenuEntry[] }) {
  const [anchor, setAnchor] = useState<ChromeAnchor>();
  return (
    <>
      <button
        className="netview-more"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        {...{ [MENU_ANCHOR_ATTR]: anchor ? "" : undefined }}
        draggable={false}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setAnchor(anchor ? undefined : chromeAnchorOf(event.currentTarget));
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {anchor ? (
        <ChromeMenu
          label={label}
          anchor={anchor}
          align="right"
          entries={entries}
          onClose={() => setAnchor(undefined)}
        />
      ) : null}
    </>
  );
}

function NetworkModal({
  title,
  initialFocus,
  onClose,
  actions,
  children,
}: {
  title: string;
  initialFocus?: string;
  onClose: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y(ref, { onClose, initialFocus });
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
          <div className="netview-modal-actions">
            {actions}
            <button className="netview-icon-button" aria-label="Close" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
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
        className="!h-7 !w-7"
        iconPixelSize={28}
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
              {network.parentId && network.selfPowered ? <SelfPoweredIcon /> : null}
              {!network.included ? " (excluded)" : ""}
            </button>
            <NetworkTree networks={networks} parentId={network.id} />
          </li>
        ))}
    </ul>
  );
}
