"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ItemPickerPopover } from "@/components/ItemPickerPopover";
import { queryRecipeDatasetResources } from "@/lib/datasets/browser-loader";
import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets/remote";
import type { DatasetResourceIndexEntry } from "@/lib/datasets/types";
import type { ResourceAmount } from "@/lib/model/types";
import { getUiScale } from "@/lib/ui-scale";
import { captureBoardSelection, useFactoryStore } from "@/store/factory-store";
import { BlueprintShelf, type BlueprintShelfRequest } from "./clean/menus/BlueprintShelf";
import { AnnotationMenu } from "./clean/note/AnnotationMenu";
import { BoardMenu, MenuLine, MenuRow } from "./clean/menus/BoardMenu";
import { CardRows } from "./clean/menus/CardActionsMenu";
import { GroupMenu } from "./clean/group/GroupMenu";
import { cloneWithSound } from "@/lib/sound/sfx";
import { isLiveConfigured } from "@/lib/live/live-config";
import { cardsForTask } from "@/lib/tasks/make-task";
import { openAddToTask } from "@/components/tasks/AddToTask";

/** Task boards come with live plans: no Add to a task row without them. */
const TASKS_ENABLED = isLiveConfigured();

/**
 * THE BOARD'S ONE RIGHT-CLICK MENU. Right click the void, a card, a drawer
 * or a wire and the same small menu opens at the pointer:
 *
 * - the void: a new product drawer, picked from the item picker the pool
 *   key uses, set down where you clicked;
 * - a machine: the card's rows (`CardRows`: clone, another recipe, replace
 *   the recipe, delete);
 * - a drawer: clone it, delete it;
 * - a wire: add a drawer HERE (the wire is cut at the click and both halves
 *   run through the new drawer), or delete the wire.
 *
 * Controls that already answer a right click (port rows open uses, a tier
 * chip steps down, the count stepper) prevent the event's default, and the
 * board's handlers do nothing for a prevented event. Kept deliberately
 * plain: no tooltips, no submenus.
 */

export type BoardMenuTarget = {
  /** Where the pointer was, in real px (the menu is a body portal). */
  x: number;
  y: number;
  /** The same point in flow space: where a new drawer lands. */
  flow: { x: number; y: number };
} & (
  | { kind: "pane" }
  | { kind: "node"; id: string }
  | { kind: "storage"; id: string }
  | { kind: "annotation"; id: string }
  | { kind: "group"; id: string }
  | { kind: "edge"; ids: string[]; resource: ResourceAmount | undefined }
);

export function BoardContextMenu({
  target,
  onClose,
}: {
  target: BoardMenuTarget;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [blueprint, setBlueprint] = useState<BlueprintShelfRequest>();
  const annotation = useFactoryStore((state) =>
    target.kind === "annotation" ? state.project.annotations?.find((entry) => entry.id === target.id) : undefined,
  );
  const group = useFactoryStore((state) =>
    target.kind === "group" ? state.project.pockets?.find((entry) => entry.id === target.id) : undefined,
  );
  const planMode = useFactoryStore((state) => state.project.planMode === true);
  const selectedIds = useFactoryStore((state) => state.selectedBoardIds);
  const editable = useFactoryStore((state) => !state.isReadOnly && !state.checklistMode);
  const datasetManifestUrl = useFactoryStore((state) => state.datasetManifestUrl);
  const datasetManifest = useFactoryStore((state) => state.datasetManifest);
  const selectedDatasetVersionId = useFactoryStore((state) => state.selectedDatasetVersionId);
  const selectedDatasetVersion = useMemo(
    () => datasetManifest?.versions.find((entry) => entry.id === selectedDatasetVersionId),
    [datasetManifest?.versions, selectedDatasetVersionId],
  );
  const searchPickerResources = useCallback(
    async (pickerQuery: string, signal: AbortSignal) => {
      if (!selectedDatasetVersion) {
        return [];
      }
      const result = await queryRecipeDatasetResources(
        datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
        selectedDatasetVersion,
        { query: pickerQuery, offset: 0, limit: 48 },
        { signal },
      );
      return result.resources;
    },
    [datasetManifestUrl, selectedDatasetVersion],
  );
  const onPick = useCallback(
    (entry: DatasetResourceIndexEntry) => {
      if (entry.kind === "aspect") {
        return;
      }
      useFactoryStore.getState().addPoolStorage(
        {
          kind: entry.kind,
          id: entry.id,
          displayName: entry.displayName,
          iconPath: entry.iconPath,
          iconAtlas: entry.iconAtlas,
          dominantColor: entry.dominantColor,
        },
        "drain",
        target.flow,
      );
      onClose();
    },
    [onClose, target.flow],
  );

  if (picking) {
    if (typeof document === "undefined") {
      return null;
    }
    // The picker where the menu was: a body portal, so real px become shell
    // px through the interface scale (ui-scale.ts).
    const scale = getUiScale();
    const left = Math.min(target.x / scale, window.innerWidth / scale - 340);
    const top = Math.min(target.y / scale, window.innerHeight / scale - 420);
    return createPortal(
      <div className="ui-zoom fixed z-[100]" style={{ left: Math.max(8, left), top: Math.max(8, top) }}>
        <ItemPickerPopover
          role="makes"
          placement="below"
          onPick={onPick}
          onClose={onClose}
          searchPickerResources={searchPickerResources}
        />
      </div>,
      document.body,
    );
  }

  const saveBlueprint = (ids: readonly string[], name: string) => {
    const payload = captureBoardSelection(useFactoryStore.getState().project, ids);
    if (payload) setBlueprint({ kind: "save", payload, name });
  };
  if (blueprint) return <BlueprintShelf request={blueprint} onClose={onClose} />;

  if (target.kind === "group") {
    return group ? <GroupMenu pocket={group} x={target.x} y={target.y} onClose={onClose}
      onSaveBlueprint={editable && planMode ? () => saveBlueprint([group.id], group.name) : undefined} /> : null;
  }
  if (target.kind === "annotation") {
    return annotation ? (
      <AnnotationMenu annotation={annotation} x={target.x} y={target.y} onClose={onClose} />
    ) : null;
  }

  const store = () => useFactoryStore.getState();
  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <BoardMenu x={target.x} y={target.y} label="Board menu" onClose={onClose}>
      {target.kind === "pane" ? <MenuRow label="New product drawer" onClick={() => setPicking(true)} /> : null}
      {target.kind === "node" ? (
        <>
        {editable && planMode ? <MenuRow label={selectedIds.includes(target.id) && selectedIds.length > 1
          ? "Save selection as blueprint" : "Save card as blueprint"}
          onClick={() => saveBlueprint(selectedIds.includes(target.id) ? selectedIds : [target.id], "")} /> : null}
        <CardRows
          nodeId={target.id}
          onClone={() => cloneWithSound(store().duplicateNode, target.id)}
          onDelete={() => store().deleteNode(target.id)}
          onAddToTask={
            TASKS_ENABLED
              ? () => void openAddToTask(cardsForTask(target.id), { left: target.x, top: target.y, bottom: target.y })
              : undefined
          }
          close={onClose}
        />
        </>
      ) : null}
      {target.kind === "storage" ? (
        <>
          <MenuRow label="Clone drawer" onClick={run(() => store().duplicateStorage(target.id))} />
          <MenuLine />
          <MenuRow label="Delete drawer" danger onClick={run(() => store().deleteStorage(target.id))} />
        </>
      ) : null}
      {target.kind === "edge" ? (
        <>
          <MenuRow
            label="Add a drawer here"
            disabled={!target.resource}
            onClick={run(() => {
              if (target.resource) {
                store().insertStorageOnEdge(target.ids, target.flow, target.resource);
              }
            })}
          />
          <MenuLine />
          <MenuRow
            label={target.ids.length > 1 ? "Delete wires" : "Delete wire"}
            danger
            onClick={run(() => store().deleteEdge(target.ids))}
          />
        </>
      ) : null}
    </BoardMenu>
  );
}
