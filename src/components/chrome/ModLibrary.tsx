"use client";

import "./chrome.css";
import "./library.css";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Ellipsis, Folder, FolderPlus, LayoutGrid, Search, Star, X } from "lucide-react";
import { requestShareDialog } from "@/lib/setups-tab";
import { openDesigns, type DesignSummary } from "@/lib/designs/design-library";
import { readDesign } from "@/lib/designs/design-storage";
import { libraryRows } from "./library-rows";
import { copyPlanCode } from "./share-actions";
import { agoText, lastOpenOf } from "@/lib/library/last-open";
import { leaveLibrary, setLibraryView, useLibraryTab, type LibraryView } from "@/lib/library/library-tab";
import { activateOnKey } from "@/lib/hooks/button-keys";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";
import { leaveWelcomeTab } from "@/lib/welcome/welcome-tab";
import { playBoardSound } from "@/lib/board-sounds";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { tipAttrs } from "@/components/flow/clean/interaction";
import { Face } from "@/components/library/LibraryTile";
import { SETUP_SORTS, SetupsGrid } from "@/components/library/SetupsGrid";
import { useSetupFilters } from "@/components/library/SetupsFilterBar";
import { useCommunityUser } from "@/components/community/auth";
import { ChromeMenu, chromeAnchorOf, MENU_ANCHOR_ATTR, type ChromeAnchor, type MenuEntry } from "./ChromeMenu";
import { SharedWithMe } from "@/components/live/SharedWithMe";
import { isLiveConfigured } from "@/lib/live/live-config";
import { useCloudLibraryStore } from "@/lib/library/cloud-library";
import { ChecklistIcon } from "./pixel-icons";
import { ListedPlanIdentity } from "./PlanIdentityStrip";

/** Plans shared with you come with live plans: none of it shows without NEXT_PUBLIC_LIVE_URL. */
const LIVE = isLiveConfigured();

/**
 * The Library (the mod's LibraryView): a header with the two shelves, My plans (every plan kept, the most recently
 * open first, after a tile for a new one) and Public setups, the search, the public list's sort and tier, the account
 * key and a close key; the shelf below. It takes the board's place and closes back onto it.
 */
export function ModLibrary() {
  const library = useLibraryTab();
  const everyDesign = useDesignStore((state) => state.designs);
  // Copies of plans shared with us are listed under Shared with me, never among ours.
  const designs = useMemo(() => everyDesign.filter((design) => !design.cloud), [everyDesign]);
  const sharedCount = useCloudLibraryStore((state) => state.shared?.length);
  const filters = useSetupFilters("top");
  const [publicTotal, setPublicTotal] = useState<number>();
  const [mineQuery, setMineQuery] = useState("");
  const [menu, setMenu] = useState<{ kind: "sort" | "tier"; anchor: ChromeAnchor }>();
  const { user } = useCommunityUser();
  const showShared = LIVE && Boolean(user);
  const shelf: "mine" | "public" | "shared" =
    library.view.kind === "public" || library.view.kind === "saved"
      ? "public"
      : library.view.kind === "shared" && showShared
        ? "shared"
        : "mine";
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const onTotal = useCallback((total: number) => setPublicTotal(total), []);

  // Esc closes the library (a text field keeps its own Esc).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      if (document.querySelector("[data-mod-menu], [data-mod-settings], [data-mod-screenshot]")) return;
      leaveLibrary();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sortLabel = SETUP_SORTS.find((entry) => entry.value === filters.sort)?.label ?? "Top voted";
  const tierIndex = filters.maxTier === "" ? -1 : Number(filters.maxTier);
  const tierLabel = tierIndex < 0 ? "Any tier" : `Up to ${GT_VOLTAGE_TIERS[tierIndex]?.tier ?? ""}`;

  const menuEntries = (kind: "sort" | "tier"): MenuEntry[] => {
    if (kind === "sort") {
      return SETUP_SORTS.map((entry) => ({
        label: entry.label,
        current: entry.value === filters.sort,
        onSelect: () => filters.setSort(entry.value),
      }));
    }
    return [
      { label: "Any tier", current: tierIndex < 0, onSelect: () => filters.setMaxTier("") },
      ...GT_VOLTAGE_TIERS.map((entry, index) => ({
        label: `Up to ${entry.tier}`,
        current: tierIndex === index,
        onSelect: () => filters.setMaxTier(String(index)),
      })),
    ];
  };

  return (
    <div className="ml mx" data-mod-library="">
      <div className="ml-head">
        <ShelfTab label="MY PLANS" count={String(designs.length)} on={shelf === "mine"} onClick={() => setLibraryView({ kind: "all" })} />
        {showShared ? (
          <ShelfTab
            label="SHARED WITH ME"
            count={sharedCount === undefined ? "..." : String(sharedCount)}
            on={shelf === "shared"}
            onClick={() => setLibraryView({ kind: "shared" })}
          />
        ) : null}
        <ShelfTab
          label="COMMUNITY"
          count={publicTotal === undefined ? "..." : compact(publicTotal)}
          on={shelf === "public"}
          onClick={() => setLibraryView({ kind: "public" })}
        />
        {shelf === "public" ? (
          <input
            className="ml-search"
            style={{ width: 300 }}
            placeholder="Search setups (#tag, @name)"
            aria-label="Search setups"
            value={filters.query}
            onChange={(event) => filters.setQuery(event.target.value)}
          />
        ) : null}
        <span className="mb-grow" />
        {shelf === "public" ? (
          <>
            <DropKey
              label={sortLabel}
              open={menu?.kind === "sort"}
              tip="How the public list is ordered"
              onOpen={(anchor) => setMenu({ kind: "sort", anchor })}
            />
            <DropKey
              label={tierLabel}
              open={menu?.kind === "tier"}
              tip="Hide setups that need a higher tier"
              onOpen={(anchor) => setMenu({ kind: "tier", anchor })}
            />
          </>
        ) : null}
        {user ? (
          <span className="ml-as" data-signed-in-as="">
            Signed in as {user.username}
          </span>
        ) : null}
        <div
          className="mb-key ml-close"
          role="button"
          aria-label="Close the panel"
          onClick={() => {
            playBoardSound("tick");
            leaveLibrary();
          }}
          {...tipAttrs({ id: "lib|close", title: "Back to the board" })}
        >
          x
        </div>
      </div>
      <div className="ml-body">
        {shelf === "mine" ? (
          <MyPlans query={mineQuery} onQueryChange={setMineQuery} view={library.view} />
        ) : shelf === "shared" ? (
          <div className="ml-public ml-shared" data-shared-shelf="">
            <SharedWithMe />
          </div>
        ) : (
          <div className="ml-public">
            <SetupsGrid scope="network" presetQuery={library.view.kind === "public" ? library.view.search : undefined} filters={filters} bare onTotal={onTotal} />
          </div>
        )}
      </div>
      {menu ? (
        <ChromeMenu
          anchor={menu.anchor}
          entries={menuEntries(menu.kind)}
          label={menu.kind === "sort" ? "Sort" : "Tier"}
          minWidth={130}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function ShelfTab({ label, count, on, onClick }: { label: string; count: string; on: boolean; onClick: () => void }) {
  return (
    <div className="ml-tab" role="tab" aria-selected={on} data-on={on ? "" : undefined} onClick={onClick}>
      <span>{label}</span>
      <i>{count}</i>
    </div>
  );
}

/** A key with a chevron: the public list's sort and tier. */
function DropKey({ label, open, tip, onOpen }: { label: string; open: boolean; tip: string; onOpen: (anchor: ChromeAnchor) => void }) {
  return (
    <div
      className="mb-key ml-drop"
      role="button"
      data-open={open ? "" : undefined}
      {...{ [MENU_ANCHOR_ATTR]: "" }}
      onClick={(event) => {
        playBoardSound("tick");
        onOpen(chromeAnchorOf(event.currentTarget));
      }}
      {...tipAttrs({ id: `lib|${label}`, title: tip })}
    >
      {label}
      <svg width="5" height="3" viewBox="0 0 5 3" shapeRendering="crispEdges" aria-hidden fill="currentColor">
        <path d="M0 0h5v1h-5zM1 1h3v1h-3zM2 2h1v1h-1z" />
      </svg>
    </div>
  );
}

// ---- My plans --------------------------------------------------------------

type MyPlansMenu = { kind: "tile" | "delete" | "move"; id: string; anchor: ChromeAnchor };
const PLAN_DRAG_TYPE = "application/x-gtnh-plan";

function MyPlans({ query, onQueryChange, view }: { query: string; onQueryChange: (query: string) => void; view: LibraryView }) {
  const everyDesign = useDesignStore((state) => state.designs);
  const allDesigns = useMemo(() => everyDesign.filter((design) => !design.cloud), [everyDesign]);
  const folders = useDesignStore((state) => state.folders);
  const activeDesignId = useDesignStore((state) => state.activeDesignId);
  const addDesign = useDesignStore((state) => state.addDesign);
  const switchToDesign = useDesignStore((state) => state.switchToDesign);
  const renameDesign = useDesignStore((state) => state.renameDesign);
  const removeDesign = useDesignStore((state) => state.removeDesign);
  const toggleFavorite = useDesignStore((state) => state.toggleFavorite);
  const moveDesignToFolder = useDesignStore((state) => state.moveDesignToFolder);
  const createFolder = useDesignStore((state) => state.createFolder);
  const linkedPostId = useFactoryStore((state) => state.project.metadata?.communityPlanId);
  const [menu, setMenu] = useState<MyPlansMenu>();
  const [collectionName, setCollectionName] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [dropTarget, setDropTarget] = useState<string>();
  const [collectionPlanId, setCollectionPlanId] = useState<string>();
  const draggedPlan = useRef<string | undefined>(undefined);
  const [problem, setProblem] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [editingDetails, setEditingDetails] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedFolder = view.kind === "folder" ? folders.find((folder) => folder.id === view.folderId) : undefined;
  const folderId = selectedFolder?.id;
  const favoritesOnly = view.kind === "favorites";
  const showingAll = !folderId && !favoritesOnly;
  const needle = query.trim().toLowerCase();
  const collectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { folderId } of allDesigns) {
      if (folderId) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return counts;
  }, [allDesigns]);
  const shown = useMemo(() => {
    const open = new Set(openDesigns(allDesigns).map((design) => design.id));
    return allDesigns
      .filter((design) => (!favoritesOnly || design.favorite) && (!folderId || design.folderId === folderId))
      .filter((design) => !needle || design.name.toLowerCase().includes(needle))
      .map((design) => ({ design, open: open.has(design.id), at: lastOpenOf(design.id, design.updatedAt) }))
      .sort((a, b) => b.at - a.at);
  }, [allDesigns, favoritesOnly, folderId, needle]);

  const addCollection = async (name: string) => {
    setCreating(true);
    setProblem(undefined);
    try {
      const folder = await createFolder(name);
      setLibraryView({ kind: "folder", folderId: folder.id });
      setCollectionName(undefined);
      setCollectionPlanId(undefined);
      if (collectionPlanId) savePlanOrganization(moveDesignToFolder(collectionPlanId, folder.id));
    } catch {
      setProblem("Could not create the collection.");
    } finally {
      setCreating(false);
    }
  };

  const savePlanOrganization = (save: Promise<void>) => {
    setProblem(undefined);
    void save.catch(() => setProblem("Could not save the plan change."));
  };

  const openCollectionForm = (id?: string) => {
    setProblem(undefined);
    setCollectionPlanId(id);
    setCollectionName("");
  };

  const finishDrag = () => {
    draggedPlan.current = undefined;
    setDropTarget(undefined);
  };
  const acceptDrop = (target: string, action: (id: string) => void) => ({
    "data-drop-active": dropTarget === target ? "" : undefined,
    onDragOver: (event: DragEvent<HTMLButtonElement>) => {
      if (!draggedPlan.current || !event.dataTransfer.types.includes(PLAN_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = target === "favorites" ? "copy" : "move";
      setDropTarget(target);
    },
    onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setDropTarget((current) => current === target ? undefined : current);
    },
    onDrop: (event: DragEvent<HTMLButtonElement>) => {
      if (!draggedPlan.current || event.dataTransfer.getData(PLAN_DRAG_TYPE) !== draggedPlan.current) return;
      event.preventDefault();
      const id = draggedPlan.current;
      finishDrag();
      action(id);
    },
  });

  const open = async (id: string) => {
    leaveWelcomeTab();
    await switchToDesign(id);
  };

  const copyCode = async (id: string) => {
    try {
      const project = id === activeDesignId ? useFactoryStore.getState().project : (await readDesign(id))?.project;
      if (!project) return;
      await copyPlanCode(project);
    } catch (error) {
      console.error(error);
    }
  };

  const menuDesign = menu ? allDesigns.find((design) => design.id === menu.id) : undefined;
  const entries = (m: MyPlansMenu): MenuEntry[] => {
    if (!menuDesign) return [];
    if (m.kind === "move") {
      const move = (id: string | undefined) => savePlanOrganization(moveDesignToFolder(m.id, id));
      return [
        { label: "No collection", current: !menuDesign.folderId, onSelect: () => move(undefined) },
        ...folders.map((folder) => ({
          label: folder.name,
          current: menuDesign.folderId === folder.id,
          onSelect: () => move(folder.id),
        })),
      ];
    }
    if (m.kind === "delete") {
      return [
        { label: "Delete it", tone: "red", onSelect: () => void removeDesign(m.id) },
        { label: "Keep it", onSelect: () => undefined },
      ];
    }
    return [
      { label: "Open", onSelect: () => void open(m.id) },
      { label: "Rename", onSelect: () => setRenaming(m.id) },
      { label: "Edit plan details", onSelect: () => setEditingDetails(m.id) },
      {
        label: menuDesign.favorite ? "Remove from Favorites" : "Add to Favorites",
        onSelect: () => savePlanOrganization(toggleFavorite(m.id)),
      },
      {
        label: "Move to collection",
        disabled: folders.length === 0,
        tip: folders.length === 0 ? "Create a collection first" : undefined,
        onSelect: () => setMenu({ ...m, kind: "move" }),
      },
      { label: "Copy plan code", detail: "to paste or share", onSelect: () => void copyCode(m.id) },
      ...libraryRows(
        Boolean(m.id === activeDesignId ? linkedPostId : menuDesign.communityPlanId),
        (mode) => {
          void (async () => {
            await open(m.id);
            requestShareDialog(mode);
          })();
        },
        { taskBoard: Boolean(menuDesign.taskBoard) },
      ),
      {
        label: "Delete plan",
        tone: "red",
        onSelect: () => setMenu({ ...m, kind: "delete" }),
      },
    ];
  };

  return (
    <div className="ml-my-plans" data-my-plans="">
      <nav className="ml-collection-nav" aria-label="Collections">
        <button type="button" className="ml-collection-row" aria-pressed={showingAll} onClick={() => setLibraryView({ kind: "all" })}>
          <LayoutGrid size={9} aria-hidden /> <span>All plans</span>
          <span className="ml-collection-count" aria-hidden>{allDesigns.length}</span>
        </button>
        <button
          type="button"
          className="ml-collection-row"
          aria-pressed={favoritesOnly}
          onClick={() => setLibraryView({ kind: "favorites" })}
          {...acceptDrop("favorites", (id) => {
            if (!useDesignStore.getState().designs.find((design) => design.id === id)?.favorite) {
              savePlanOrganization(toggleFavorite(id));
            }
          })}
        >
          <Star size={9} aria-hidden /> <span>Favorites</span>
          <span className="ml-collection-count" aria-hidden>{allDesigns.filter((design) => design.favorite).length}</span>
        </button>
        {folders.map((folder) => (
          <button
            type="button"
            key={folder.id}
            className="ml-collection-row"
            aria-pressed={folderId === folder.id}
            onClick={() => setLibraryView({ kind: "folder", folderId: folder.id })}
            {...acceptDrop(folder.id, (id) => savePlanOrganization(moveDesignToFolder(id, folder.id)))}
          >
            <Folder size={9} aria-hidden /> <span>{folder.name}</span>
            <span className="ml-collection-count" aria-hidden>{collectionCounts.get(folder.id) ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          className="ml-collection-row ml-collection-add"
          onClick={() => openCollectionForm()}
          {...acceptDrop("new", openCollectionForm)}
        >
          <FolderPlus size={9} aria-hidden /> <span>New collection</span>
        </button>
        {collectionName !== undefined ? (
          <form
            className="ml-collection-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = collectionName.trim();
              if (name && !creating) void addCollection(name);
            }}
          >
            <input
              className="ml-search"
              aria-label="Collection name"
              placeholder="Collection name"
              value={collectionName}
              disabled={creating}
              autoFocus
              onChange={(event) => setCollectionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setCollectionName(undefined);
                }
              }}
            />
            <button type="submit" className="mb-key" disabled={creating || !collectionName.trim()}>Create</button>
            <button type="button" className="mb-key" disabled={creating} onClick={() => setCollectionName(undefined)}>Cancel</button>
          </form>
        ) : null}
      </nav>
      <div className="ml-plan-content">
        <label className="ml-plan-search">
          <Search size={9} aria-hidden />
          <input
            className="ml-search"
            placeholder="Find a plan"
            aria-label="Find a plan"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        {problem ? <p className="ml-plan-message" role="alert">{problem}</p> : null}
        {editingDetails && allDesigns.some((design) => design.id === editingDetails) ? (
          <div className="ml-plan-details">
            <ListedPlanIdentity key={editingDetails} designId={editingDetails} />
            <button
              type="button"
              className="mb-key"
              aria-label="Close plan details"
              onClick={() => setEditingDetails(undefined)}
            >
              <X size={10} aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="ml-grid">
          {showingAll ? (
            <div
              className="ml-tile ml-new"
              role="button"
              tabIndex={0}
              onKeyDown={activateOnKey}
              onClick={() => {
                playBoardSound("tick");
                leaveWelcomeTab();
                void addDesign();
              }}
            >
              + New plan
            </div>
          ) : null}
          {shown.map(({ design, open: isOpen, at }) => (
            <PlanTile
              key={design.id}
              design={design}
              showing={design.id === activeDesignId}
              open={isOpen}
              when={agoText(at, now)}
              collection={folders.find((folder) => folder.id === design.folderId)?.name}
              onDragStart={(event) => {
                draggedPlan.current = design.id;
                event.dataTransfer.effectAllowed = "copyMove";
                event.dataTransfer.setData(PLAN_DRAG_TYPE, design.id);
              }}
              onDragEnd={finishDrag}
              renaming={renaming === design.id}
              onOpen={() => void open(design.id)}
              onMenu={(anchor) => setMenu({ kind: "tile", id: design.id, anchor })}
              onRename={(name) => {
                setRenaming(undefined);
                if (name && name !== design.name) void renameDesign(design.id, name);
              }}
            />
          ))}
        </div>
        {shown.length === 0 && (!showingAll || needle) ? (
          <p className="ml-plan-message">
            {needle ? "No plans match your search." : favoritesOnly ? "Add a plan to Favorites from its options." : "Drag a plan here or use Move to collection in its options."}
          </p>
        ) : null}
      </div>
      {menu && menuDesign ? (
        <ChromeMenu
          key={menu.kind}
          anchor={menu.anchor}
          entries={entries(menu)}
          label={menu.kind === "move" ? "Move to collection" : `Plan options for ${menuDesign?.name}`}
          title={menu.kind === "delete" ? `Delete '${menuDesign?.name}' for good?` : undefined}
          minWidth={menu.kind === "delete" ? 150 : 190}
          onClose={() => setMenu(undefined)}
        />
      ) : null}
    </div>
  );
}

function PlanTile({
  design,
  showing,
  open,
  when,
  collection,
  onDragStart,
  onDragEnd,
  renaming,
  onOpen,
  onMenu,
  onRename,
}: {
  design: DesignSummary;
  showing: boolean;
  open: boolean;
  when: string;
  collection?: string;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  renaming: boolean;
  onOpen: () => void;
  onMenu: (anchor: ChromeAnchor) => void;
  onRename: (name: string) => void;
}) {
  const cards = design.stats ? Math.max(0, design.stats.cards - (design.stats.drawers ?? 0)) : undefined;
  const drawers = design.stats?.drawers;
  const tasks = design.stats?.tasks ?? 0;
  const size = design.taskBoard
    ? `${tasks} ${tasks === 1 ? "task" : "tasks"}`
    : cards === undefined
      ? undefined
      : `${cards} ${cards === 1 ? "card" : "cards"}${drawers === undefined ? "" : ` · ${drawers} ${drawers === 1 ? "drawer" : "drawers"}`}`;
  const drawable = Boolean(design.icon && (design.icon.iconPath || design.icon.iconAtlas || design.icon.kind === "fluid"));
  return (
    <div
      className="ml-tile"
      data-tasks={design.taskBoard ? "" : undefined}
      data-showing={showing ? "" : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onMenu({ left: rect.left + 8, top: rect.top, bottom: rect.top + 20 });
      }}
    >
      <div
        className="ml-tile-open"
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={renaming ? undefined : `Open ${design.name}`}
        onClick={() => !renaming && onOpen()}
        onKeyDown={activateOnKey}
        {...tipAttrs({
          id: `lib|plan:${design.id}`,
          title: design.name,
          sub: showing ? "On the board now" : "Click to open it",
          actions: [
            { input: "left", label: "Open" },
            { input: "right", label: "More" },
          ],
        })}
      >
        <span className="ml-face">
          {drawable ? <Face icon={design.icon} size={24} /> : <span className="ml-noface" />}
        </span>
        {open ? <span className="ml-chip" data-showing={showing ? "" : undefined}>{showing ? "SHOWING" : "OPEN"}</span> : null}
        {renaming ? (
          <TileRename initial={design.name} onDone={onRename} />
        ) : (
          <span className="ml-name">
            {design.taskBoard ? <ChecklistIcon className="ml-tasks" /> : null}
            {design.favorite ? <Star className="ml-favorite" size={8} fill="currentColor" aria-hidden /> : null}
            {design.name}
          </span>
        )}
        {size ? <span className="ml-size">{size}</span> : null}
        <span className="ml-when">{collection ? `${collection} · ` : ""}last open {when}</span>
        {design.communityPlanId ? <span className="ml-posted">posted</span> : null}
      </div>
      <button
        type="button"
        className="mb-key ml-tile-more"
        aria-label={`Options for ${design.name}`}
        aria-haspopup="menu"
        {...{ [MENU_ANCHOR_ATTR]: "" }}
        onClick={(event) => onMenu(chromeAnchorOf(event.currentTarget))}
      >
        <Ellipsis size={11} aria-hidden />
      </button>
    </div>
  );
}

function TileRename({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(commit ? value.trim() : "");
  };
  return (
    <input
      autoFocus
      className="ml-rename"
      aria-label="Plan name"
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
    />
  );
}
