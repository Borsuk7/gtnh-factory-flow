"use client";

import "./chrome.css";
import "./power-picker.css";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { playBoardSound } from "@/lib/board-sounds";
import { getUiScale } from "@/lib/ui-scale";
import { GT_VOLTAGE_TIERS } from "@/lib/model";
import { getPowerMachineIcon } from "@/lib/power/planner-data";
import { hitPlacementSettings, searchPowerSources, type PowerSearchHit } from "@/lib/power/power-search";
import { POWER_GROUPS, POWER_SOURCES } from "@/lib/power/registry";
import { getPowerStructureArt } from "@/lib/power/structure-art";
import type { PowerGroupId } from "@/lib/power/types";
import { useFactoryStore } from "@/store/factory-store";
import { ResourceIcon } from "@/components/nei/ResourceIcon";
import { tierChipColors } from "@/components/flow/clean/tokens";
import { measureClean } from "@/components/flow/clean/text-measure";
import { CHROME_SCREEN_K, ChromeMenu, chromeAnchorOf, MENU_ANCHOR_ATTR, type ChromeAnchor, type MenuEntry } from "./ChromeMenu";
import { PixelBolt } from "./pixel-icons";

/** The sheet's width with the backdrop's side padding, in the mod's GUI pixels (power-picker.css .mp, .mp-backdrop). */
const SHEET_W = 802 + 16;

/** The columns of kinds, the short groups sharing one (the mod's COLUMNS). */
const COLUMNS: ReadonlyArray<ReadonlyArray<PowerGroupId>> = [
  ["other", "burners"],
  ["turbines"],
  ["steam"],
  ["engines", "passive"],
  ["reactors", "endgame"],
];

/** The planning cards the picker lists first: no recipe, no tier. */
interface OtherCard {
  id: "custom-rate" | "fluid-tank" | "crop-farm";
  name: string;
  blurb: string;
}
const OTHERS: readonly OtherCard[] = [
  { id: "custom-rate", name: "Custom Rate", blurb: "A rate you set: supplies or drains any resource, at a dial." },
  { id: "fluid-tank", name: "Fluid Tank", blurb: "Empties a filled cell into its fluid and the empty cell, or fills cells. Free and instant." },
  { id: "crop-farm", name: "Crop Farm", blurb: "Crops planted and harvested: pick the crop on the card." },
];

type Entry =
  | { kind: "source"; hit: PowerSearchHit }
  | { kind: "other"; card: OtherCard };

const TIER_FILTERS = GT_VOLTAGE_TIERS.map((entry) => entry.tier).filter((tier) =>
  POWER_SOURCES.some((source) => source.unlock === tier),
);

/**
 * The non-recipe machines (the mod's PowerPicker): everything you can put on the board that does not run a recipe,
 * over a dimmed board: the planning cards first (Other: the custom rate card, the fluid tank), then the power sources
 * in five columns of kinds, one tile per machine with its picture, its name and the tier that unlocks it, and a
 * larger picture beside the tile the mouse has rested on. Typing searches the machines and everything they burn or
 * make, so "benzene" finds every machine that runs on it and places it with that fuel set.
 */
export function ModPowerPicker({ compact = false }: { compact?: boolean }) {
  const open = useFactoryStore((state) => state.powerMenuOpen);
  const closePowerMenu = useFactoryStore((state) => state.closePowerMenu);
  const addPowerSourceNode = useFactoryStore((state) => state.addPowerSourceNode);
  const addCustomRateNode = useFactoryStore((state) => state.addCustomRateNode);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<PowerGroupId | "all">("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [menu, setMenu] = useState<{ kind: "group" | "tier"; anchor: ChromeAnchor }>();
  const [preview, setPreview] = useState<{ entry: Entry; rect: DOMRect }>();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ left: 0, right: 0, top: 0, zoom: 1 });

  // Esc closes it, from anywhere (the search too).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[data-mod-menu]")) {
        event.stopPropagation();
        closePowerMenu();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, closePowerMenu]);

  // Opens fresh: no search, no filters.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setGroupFilter("all");
      setTierFilter("all");
      setMenu(undefined);
      setPreview(undefined);
    }
  }

  // Over the overview and the board only: the items list beside them stays bright.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      if (compact) {
        setFrame({ left: 0, right: 0, top: 0, zoom: getUiScale() * CHROME_SCREEN_K });
        return;
      }
      const main = document.querySelector<HTMLElement>("main[data-items-side]");
      // Below the board's toolbar when there is one: its Non-recipe key closes the picker again.
      const strip = document.querySelector<HTMLElement>("header[data-board-toolbar]");
      const groups = strip ? Array.from(strip.children) : [];
      const bottom = groups.length ? Math.max(...groups.map((group) => group.getBoundingClientRect().bottom)) : 0;
      const bar = strip ? { getBoundingClientRect: () => ({ bottom }) } : document.querySelector<HTMLElement>("[data-mod-bar]");
      // The mod's size, as the bar and its menus wear it (CHROME_SCREEN_K on the interface's zoom), or smaller where the
      // board is too narrow for the sheet: the whole picker shrinks rather than its columns cutting the names off.
      // The items list is on the right, or on the left where the settings put it there.
      const itemsLeft = main?.dataset.itemsSide === "left" && main.hasAttribute("data-plan-layout");
      const items = (main ? Number((itemsLeft ? main.dataset.leftPx : main.dataset.rightPx) ?? 0) : 0) * getUiScale();
      const room = window.innerWidth - items;
      const zoom = Math.min(getUiScale() * CHROME_SCREEN_K, room / SHEET_W);
      const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
      const inset = Math.round(items / zoom);
      setFrame({ left: itemsLeft ? inset : 0, right: itemsLeft ? 0 : inset, top: Math.round(barBottom / zoom), zoom });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, compact]);

  const entries = useMemo<Entry[]>(() => {
    if (!open) return [];
    const needle = query.trim().toLowerCase();
    const out: Entry[] = [];
    if (tierFilter === "all" && (groupFilter === "all" || groupFilter === "other")) {
      for (const card of OTHERS) {
        if (!needle || card.name.toLowerCase().includes(needle) || card.blurb.toLowerCase().includes(needle)) {
          out.push({ kind: "other", card });
        }
      }
    }
    // Then the sources: Other's own (the Railcraft Water Tank) come after its planning cards.
    for (const hit of searchPowerSources(query)) {
      if (groupFilter !== "all" && hit.source.group !== groupFilter) continue;
      if (tierFilter !== "all" && hit.source.unlock !== tierFilter) continue;
      out.push({ kind: "source", hit });
    }
    return out;
  }, [open, query, groupFilter, tierFilter]);

  const place = useCallback(
    (entry: Entry) => {
      playBoardSound("tick");
      if (entry.kind === "other") {
        if (entry.card.id === "custom-rate") addCustomRateNode();
        else if (entry.card.id === "crop-farm") useFactoryStore.getState().addCropFarmNode();
        else (useFactoryStore.getState() as unknown as { addFluidTankNode?: () => void }).addFluidTankNode?.();
        closePowerMenu();
        return;
      }
      addPowerSourceNode(entry.hit.source.id, hitPlacementSettings(entry.hit));
    },
    [addCustomRateNode, addPowerSourceNode, closePowerMenu],
  );

  if (!open) return null;

  const searching = query.trim() !== "";
  const groupTitle = (id: PowerGroupId) => POWER_GROUPS.find((group) => group.id === id)?.name ?? id;
  const inGroup = (id: PowerGroupId) =>
    entries.filter((entry) => (entry.kind === "other" ? id === "other" : entry.hit.source.group === id));

  const menuEntries: MenuEntry[] =
    menu?.kind === "group"
      ? [
          { label: "All types", current: groupFilter === "all", onSelect: () => setGroupFilter("all") },
          ...POWER_GROUPS.map((group) => ({
            label: group.name,
            current: groupFilter === group.id,
            onSelect: () => setGroupFilter(group.id),
          })),
        ]
      : [
          { label: "All tiers", current: tierFilter === "all", onSelect: () => setTierFilter("all") },
          ...TIER_FILTERS.map((tier) => ({ label: tier, current: tierFilter === tier, onSelect: () => setTierFilter(tier) })),
        ];

  const columns = COLUMNS.map((groups) => groups.filter((id) => inGroup(id).length > 0)).filter((groups) => groups.length > 0);
  const tile = (entry: Entry): ReactNode => (
    <Tile
      key={entry.kind === "other" ? `other:${entry.card.id}` : entry.hit.source.id}
      entry={entry}
      compact={compact}
      onPlace={place}
      onRest={(rect) => setPreview(rect ? { entry, rect } : undefined)}
    />
  );

  return createPortal(
    <div
      className="mp-backdrop"
      data-compact={compact ? "" : undefined}
      style={{ left: frame.left, right: frame.right, top: frame.top, zoom: frame.zoom }}
      onPointerDown={closePowerMenu}
    >
      <div
        ref={sheetRef}
        className="mp mx"
        role="dialog"
        aria-label="Non-recipe machines"
        data-mod-power-picker=""
        onPointerDown={(event) => event.stopPropagation()}
        onScroll={() => setPreview(undefined)}
      >
        <div className="mp-head">
          <PixelBolt className="mp-bolt" />
          <span className="mp-title">NON-RECIPE MACHINES</span>
          <span className="mb-grow" />
          <input
            autoFocus={!compact}
            className="ml-search mp-search"
            placeholder="Machine, fuel, or product..."
            aria-label="Machine, fuel, or product"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <PickerKey
            label={groupFilter === "all" ? "All types" : groupTitle(groupFilter)}
            open={menu?.kind === "group"}
            onOpen={(anchor) => setMenu((current) => (current?.kind === "group" ? undefined : { kind: "group", anchor }))}
          />
          <PickerKey
            label={tierFilter === "all" ? "All tiers" : tierFilter}
            open={menu?.kind === "tier"}
            onOpen={(anchor) => setMenu((current) => (current?.kind === "tier" ? undefined : { kind: "tier", anchor }))}
          />
          <button type="button" className="mb-key mp-close" aria-label="Close" onClick={closePowerMenu}>
            x
          </button>
        </div>
        <div className="mp-body" onScroll={() => setPreview(undefined)}>
          {entries.length === 0 ? (
            <div className="mp-none">No machine burns, makes or is named that.</div>
          ) : searching ? (
            <div className="mp-results">{entries.map(tile)}</div>
          ) : (
            <div className="mp-columns">
              {columns.map((groups, index) => (
                <div key={index} className="mp-col">
                  {groups.map((id) => (
                    <div key={id} className="mp-group">
                      <div className="mp-brass">
                        <span>{groupTitle(id).toUpperCase()}</span>
                        <i>{inGroup(id).length}</i>
                      </div>
                      {inGroup(id).map(tile)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {preview && !compact ? <Preview entry={preview.entry} rect={preview.rect} scale={frame.zoom} /> : null}
      {menu ? (
        <ChromeMenu
          anchor={menu.anchor}
          entries={menuEntries}
          label={menu.kind === "group" ? "Type" : "Tier"}
          minWidth={120}
          onClose={() => setMenu(undefined)}
        />
      ) : null}
    </div>,
    document.body,
  );
}

function PickerKey({ label, open, onOpen }: { label: string; open: boolean; onOpen: (anchor: ChromeAnchor) => void }) {
  return (
    <button
      className="mb-key ml-drop"
      type="button"
      data-open={open ? "" : undefined}
      {...{ [MENU_ANCHOR_ATTR]: "" }}
      onClick={(event) => {
        playBoardSound("tick");
        onOpen(chromeAnchorOf(event.currentTarget));
      }}
    >
      {label}
      <svg width="5" height="3" viewBox="0 0 5 3" shapeRendering="crispEdges" aria-hidden fill="currentColor">
        <path d="M0 0h5v1h-5zM1 1h3v1h-3zM2 2h1v1h-1z" />
      </svg>
    </button>
  );
}

/** The 800 ms the tips wait: the larger picture shows once the mouse has rested on a tile. */
const REST_MS = 800;

function Tile({ entry, compact, onPlace, onRest }: {
  entry: Entry;
  compact: boolean;
  onPlace: (entry: Entry) => void;
  onRest: (rect: DOMRect | undefined) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = entry.kind === "other" ? entry.card.name : entry.hit.source.name;
  const tier = entry.kind === "other" ? undefined : entry.hit.source.unlock;
  const via = entry.kind === "source" ? entry.hit.via : undefined;
  return (
    <button
      className="mp-tile"
      type="button"
      data-via={via ? "" : undefined}
      data-source={entry.kind === "other" ? entry.card.id : entry.hit.source.id}
      onClick={() => onPlace(entry)}
      onMouseEnter={(event) => {
        if (compact) return;
        const element = event.currentTarget;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onRest(element.getBoundingClientRect()), REST_MS);
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        onRest(undefined);
      }}
    >
      <span className="mp-art">
        <MachineArt entry={entry} size={24} />
      </span>
      {compact ? <span className="mp-name">{name}</span> : <NameLines name={name} tier={tier} />}
      {tier ? <TierTag tier={tier} /> : null}
      {via ? <span className="mp-via">{via.direction === "takes" ? "Takes " : "Makes "}{via.name}</span> : null}
    </button>
  );
}

/** A tile's room for its name: 150 less the picture, as the mod lays the row out. */
const NAME_ROOM = 150 - 44 - 8;

/** Fits text to a width, with an ellipsis where it does not. */
function fitText(text: string, room: number): string {
  if (measureClean(text, 8) <= room) return text;
  let end = text.length;
  while (end > 1 && measureClean(`${text.slice(0, end)}...`, 8) > room) end -= 1;
  return `${text.slice(0, end)}...`;
}

/**
 * The name on one line beside the tier tag when both fit, else on two with the tag on the second (the mod's rows).
 */
function NameLines({ name, tier }: { name: string; tier?: string }) {
  const tagWidth = tier ? measureClean(tier, 8) + 6 : 0;
  if (measureClean(name, 8) + 4 + tagWidth <= NAME_ROOM) {
    return <span className="mp-line" style={{ top: 11 - 1 }}>{name}</span>;
  }
  const words = name.split(" ");
  let first = "";
  let used = 0;
  for (; used < words.length; used++) {
    const next = first ? `${first} ${words[used]}` : words[used];
    if (first && measureClean(next, 8) > NAME_ROOM) break;
    first = next;
  }
  const rest = words.slice(used).join(" ");
  return (
    <>
      <span className="mp-line" style={{ top: 5 - 1 }}>{fitText(first, NAME_ROOM)}</span>
      {rest ? <span className="mp-line" style={{ top: 16 - 1 }}>{fitText(rest, NAME_ROOM - 4 - tagWidth)}</span> : null}
    </>
  );
}

function TierTag({ tier }: { tier: string }) {
  const colours = tierChipColors(tier);
  return (
    <span
      className="mp-tier"
      style={
        colours
          ? { background: colours.background, boxShadow: `0 0 0 1px ${colours.border}`, color: colours.ink, textDecoration: colours.underline ? "underline" : undefined }
          : undefined
      }
    >
      {tier}
    </span>
  );
}

function MachineArt({ entry, size }: { entry: Entry; size: number }) {
  if (entry.kind === "other") {
    if (entry.card.id === "crop-farm") return <SproutArt size={size} />;
    return entry.card.id === "custom-rate" ? <Gauge scale={size >= 40 ? 4 : 2} /> : <TankArt size={size} />;
  }
  const art = getPowerStructureArt(entry.hit.source.id);
  if (art) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={art} alt="" draggable={false} className="mp-img" />;
  }
  const icon = getPowerMachineIcon(entry.hit.source.id);
  if (icon?.iconPath) {
    return (
      <span className="mp-icon" style={{ width: size, height: size }}>
        <ResourceIcon
          resource={{ kind: "item", id: icon.id, amount: 1, displayName: icon.displayName, iconPath: icon.iconPath, dominantColor: icon.dominantColor }}
          bare
          tooltip={false}
          showAmount={false}
          showConsumedState={false}
          iconPixelSize={size * 2}
          className="!h-full !w-full"
        />
      </span>
    );
  }
  return <PixelBolt className="mp-bolt" />;
}

/** The custom rate card's dial (`PowerPicker.gauge`), 9 x 8. */
function Gauge({ scale }: { scale: number }) {
  const runs: ReadonlyArray<readonly [number, number, number]> = [
    [2, 0, 5], [1, 1, 1], [7, 1, 1], [0, 2, 1], [6, 2, 1], [8, 2, 1], [0, 3, 1], [5, 3, 1], [8, 3, 1],
    [0, 4, 1], [4, 4, 1], [8, 4, 1], [0, 5, 1], [3, 5, 2], [8, 5, 1], [1, 6, 1], [7, 6, 1],
  ];
  const d = runs.map(([x, y, w]) => `M${x} ${y}h${w}v1h-${w}z`).join("");
  return (
    <svg width={9 * scale} height={8 * scale} viewBox="0 0 9 8" shapeRendering="crispEdges" fill="#aebceb" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** A sprout on farmland: the crop farm. */
function SproutArt({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      <path d="M1 11h14v4H1z" fill="#5b3b22" />
      <path d="M1 11h14v1H1z" fill="#7a5230" />
      <path d="M7 4h1v7H7z" fill="#3f8f2a" />
      <path d="M3 4h4v1H3zM4 5h3v1H4zM8 6h4v1H8zM8 7h3v1H8z" fill="#5cc23b" />
    </svg>
  );
}

/** A small tank: the fluid tank's picture until the card's own art lands. */
function TankArt({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden>
      <path d="M12 2l9 5v10l-9 5-9-5V7z" fill="#8a93a6" />
      <path d="M12 2l9 5-9 5-9-5z" fill="#b9c0cf" />
      <path d="M12 12v10l-9-5V7z" fill="#6b7384" />
      <path d="M8 9h2v2H8zM14 14h2v2h-2zM7 15h2v2H7z" fill="#1d1f23" />
    </svg>
  );
}

/** The machine under the mouse, beside its tile: its picture large, its name, kind and unlock tier, what it does. */
function Preview({ entry, rect, scale }: { entry: Entry; rect: DOMRect; scale: number }) {
  const source = entry.kind === "source" ? entry.hit.source : undefined;
  const name = source?.name ?? (entry.kind === "other" ? entry.card.name : "");
  const kind = source ? (POWER_GROUPS.find((group) => group.id === source.group)?.name ?? "") : "Other";
  const blurb = source?.blurb ?? (entry.kind === "other" ? entry.card.blurb : "");
  const width = 190;
  const vw = window.innerWidth / scale;
  let left = rect.right / scale + 6;
  if (left + width > vw - 2) left = rect.left / scale - 6 - width;
  left = Math.max(2, left);
  const top = Math.max(2, rect.top / scale - 20);
  return (
    <div className="mp-preview" style={{ left, top, width }}>
      <div className="mp-preview-art">
        <MachineArt entry={entry} size={48} />
      </div>
      <div className="mp-preview-name">{name}</div>
      <div className="mp-preview-kind">
        {kind}
        {source?.unlock ? `, unlocks at ${source.unlock}` : ""}
      </div>
      <div className="mp-preview-blurb">{blurb}</div>
      {entry.kind === "source" && entry.hit.via ? (
        <div className="mp-via">
          {entry.hit.via.direction === "takes" ? "Takes " : "Makes "}
          {entry.hit.via.name}
        </div>
      ) : null}
    </div>
  );
}
