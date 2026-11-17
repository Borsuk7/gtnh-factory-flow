"use client";

import { useState } from "react";
import type { FactoryPocket } from "@/lib/model/types";
import { playSfx } from "@/lib/sound/sfx";
import { useFactoryStore } from "@/store/factory-store";
import { BoardMenu, MenuLine, MenuRow } from "../menus/BoardMenu";
import { NOTE_COLOR_MENU } from "../note/note-model";
import { GT_NODE_COLORS } from "../../node-colors";
import { groupColorTag } from "./group-model";
import { requestGroupRename } from "./group-rename";

/**
 * A group's right-click menu (docs/groups.md, "Menus"), the mod's rows and words: Rename, Collapse or Expand, Colour...,
 * Ungroup (keeps contents), and in red Delete group and contents. The mod's twin is `ui/group/GroupCard.openMenu`.
 */
export function GroupMenu({ pocket, x, y, onClose, onSaveBlueprint }: {
  pocket: FactoryPocket; x: number; y: number; onClose: () => void; onSaveBlueprint?: () => void;
}) {
  const [view, setView] = useState<"main" | "colour">("main");
  const store = () => useFactoryStore.getState();
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  if (view === "colour") {
    const current = groupColorTag(pocket);
    return (
      <BoardMenu x={x} y={y} label="Group colour" title="Colour" onClose={onClose}>
        {NOTE_COLOR_MENU.map(([tag, name]) => (
          <MenuRow
            key={tag}
            label={name}
            swatch={GT_NODE_COLORS[tag]?.swatch}
            checked={tag === current}
            onClick={run(() => {
              playSfx("board.adjust");
              store().paintPocket(pocket.id, tag);
            })}
          />
        ))}
      </BoardMenu>
    );
  }
  return (
    <BoardMenu x={x} y={y} label="Group" onClose={onClose}>
      <MenuRow label="Rename" onClick={run(() => requestGroupRename(pocket.id))} />
      {pocket.expanded ? (
        <MenuRow label="Collapse" onClick={run(() => store().minimizePocket(pocket.id))} />
      ) : (
        <MenuRow label="Expand" onClick={run(() => store().expandPocket(pocket.id))} />
      )}
      <MenuRow label="Colour..." onClick={() => setView("colour")} />
      {onSaveBlueprint ? <MenuRow label="Save group as blueprint" onClick={onSaveBlueprint} /> : null}
      <MenuRow
        label="Ungroup (keeps contents)"
        onClick={run(() => {
          playSfx("board.sweep", 0.8, 0.9);
          store().dissolvePocket(pocket.id);
        })}
      />
      <MenuLine />
      <MenuRow
        label="Delete group and contents"
        danger
        onClick={run(() => store().deleteBoardSelection({ nodeIds: [pocket.id] }))}
      />
    </BoardMenu>
  );
}
