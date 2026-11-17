"use client";

import { useState } from "react";
import type { DesignFolder, DesignSummary } from "@/lib/designs/design-library";
import { readDesign } from "@/lib/designs/design-storage";
import { requestShareDialog } from "@/lib/setups-tab";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { ChromeMenu, type ChromeAnchor, type MenuEntry } from "./ChromeMenu";
import { libraryRows } from "./library-rows";
import { copyPlanCode } from "./share-actions";

export function PlanListMenu({ design, folders, anchor, onClose, onOpen, onRename, onEdit, onError }: {
  design: DesignSummary;
  folders: DesignFolder[];
  anchor: ChromeAnchor;
  onClose: () => void;
  onOpen: () => Promise<void>;
  onRename: () => void;
  onEdit: () => void;
  onError: (message: string) => void;
}) {
  const [page, setPage] = useState<"actions" | "move" | "delete">("actions");
  const { id, name } = design;
  const store = useDesignStore.getState();
  const active = id === store.activeDesignId;
  const linked = active ? useFactoryStore.getState().project.metadata?.communityPlanId : design.communityPlanId;
  const run = (action: () => Promise<unknown>) => () => {
    void action().catch(() => onError("Could not complete the plan action."));
  };
  const move = (folderId?: string) => run(() => store.moveDesignToFolder(id, folderId));
  let entries: MenuEntry[];
  if (page === "move") {
    entries = [
      { label: "No collection", current: !design.folderId, onSelect: move() },
      ...folders.map((folder) => ({ label: folder.name, current: design.folderId === folder.id, onSelect: move(folder.id) })),
    ];
  } else if (page === "delete") {
    entries = [
      { label: "Delete it", tone: "red", onSelect: run(() => store.removeDesign(id)) },
      { label: "Keep it", onSelect: () => undefined },
    ];
  } else {
    entries = [
      { label: "Open", onSelect: run(onOpen) },
      { label: "Rename", onSelect: onRename },
      { label: "Edit plan details", onSelect: onEdit },
      { label: "Duplicate", onSelect: run(() => store.copyDesign(id)) },
      ...(!design.closed ? [{ label: "Close tab", onSelect: run(() => store.closeDesign(id)) }] : []),
      { label: design.favorite ? "Remove from Favorites" : "Add to Favorites", onSelect: run(() => store.toggleFavorite(id)) },
      {
        label: "Move to collection",
        disabled: folders.length === 0,
        tip: folders.length === 0 ? "Create a collection first" : undefined,
        keepOpen: true,
        onSelect: () => setPage("move"),
      },
      {
        label: "Copy plan code",
        detail: "to paste or share",
        onSelect: run(async () => {
          const project = active ? useFactoryStore.getState().project : (await readDesign(id))?.project;
          if (project) await copyPlanCode(project);
        }),
      },
      ...libraryRows(Boolean(linked), (mode) => {
        run(async () => {
          await onOpen();
          requestShareDialog(mode);
        })();
      }, { taskBoard: Boolean(design.taskBoard) }),
      { label: "Delete plan", tone: "red", keepOpen: true, onSelect: () => setPage("delete") },
    ];
  }
  return (
    <ChromeMenu
      key={page}
      anchor={anchor}
      entries={entries}
      label={page === "move" ? "Move to collection" : `Plan options for ${name}`}
      title={page === "delete" ? `Delete '${name}' for good?` : undefined}
      minWidth={page === "delete" ? 150 : 190}
      fitViewport
      onClose={onClose}
    />
  );
}
