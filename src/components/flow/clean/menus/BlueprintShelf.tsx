"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  listDeviceBlueprints, removeDeviceBlueprint, saveDeviceBlueprint, type DeviceBlueprint,
} from "@/lib/blueprints/device-shelf";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore, type BoardClipboardPayload } from "@/store/factory-store";

export type BlueprintShelfRequest =
  | { kind: "save"; payload: BoardClipboardPayload; name: string }
  | { kind: "place"; point: { x: number; y: number } };

export function BlueprintShelf({ request, onClose }: { request: BlueprintShelfRequest; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const designAtOpen = useRef(useDesignStore.getState().activeDesignId);
  const [name, setName] = useState(request.kind === "save" ? request.name : "");
  const [blueprints, setBlueprints] = useState<DeviceBlueprint[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleteId, setDeleteId] = useState<string>();
  const saving = request.kind === "save";

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (saving) return;
    let active = true;
    void listDeviceBlueprints().then(
      (rows) => { if (active) setBlueprints(rows.sort((a, b) => a.name.localeCompare(b.name))); },
      () => { if (active) setError("Blueprints could not be opened."); },
    );
    return () => { active = false; };
  }, [saving]);

  const save = async () => {
    if (request.kind !== "save" || !name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveDeviceBlueprint(name.trim(), request.payload);
      onClose();
    } catch {
      setError("Blueprint could not be saved.");
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try {
      await removeDeviceBlueprint(id);
      setBlueprints((rows) => rows?.filter((row) => row.id !== id));
      setDeleteId(undefined);
    } catch {
      setError("Blueprint could not be deleted.");
    } finally {
      setBusy(false);
    }
  };
  const place = (payload: BoardClipboardPayload) => {
    if (request.kind !== "place") return;
    const state = useFactoryStore.getState();
    if (state.isReadOnly || state.checklistMode || useDesignStore.getState().activeDesignId !== designAtOpen.current) {
      setError("Open the blueprint shelf from the plan where you want to place it.");
      return;
    }
    const { point } = request;
    const pocketIds = new Set(payload.pockets.map(({ id }) => id));
    const roots = [
      ...payload.pockets.filter((entry) => !pocketIds.has(entry.parentPocketId ?? "")),
      ...[...payload.nodes, ...payload.storages, ...payload.annotations].filter(
        (entry) => !pocketIds.has(entry.pocketId ?? ""),
      ),
    ];
    const topLeft = roots.reduce(
      (min, { position }) => ({ x: Math.min(min.x, position.x), y: Math.min(min.y, position.y) }),
      { x: Infinity, y: Infinity },
    );
    if (roots.length === 0) {
      setError("This blueprint has no cards to place.");
      return;
    }
    const ids = state.pasteBoardItems(payload, { x: point.x - topLeft.x, y: point.y - topLeft.y });
    if (ids.length) state.setPendingBoardSelection(ids);
    onClose();
  };

  return createPortal(
    <dialog ref={dialog} className="blueprint-shelf ui-zoom" aria-labelledby="blueprint-shelf-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header>
        <h2 id="blueprint-shelf-title">{saving ? "Save blueprint" : "Place blueprint"}</h2>
        <button className="cm-compare-key" onClick={onClose} disabled={busy}>Close</button>
      </header>
      {saving ? (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label>Blueprint name<input className="cm-filter" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <p>Saved on this device. Open the board menu in any plan to place it.</p>
          <button className="cm-compare-key" type="submit" disabled={!name.trim() || busy}>Save blueprint</button>
        </form>
      ) : (
        <div className="blueprint-list">
          {blueprints?.length === 0 ? <p>No blueprints on this device.</p> : null}
          {!blueprints && !error ? <p>Loading blueprints…</p> : null}
          {blueprints?.map((entry) => (
            <div key={entry.id} className="blueprint-row">
              <span>{entry.name}</span>
              {deleteId === entry.id ? <>
                <button className="cm-compare-key" onClick={() => void remove(entry.id)} disabled={busy}>Delete blueprint</button>
                <button className="cm-compare-key" onClick={() => setDeleteId(undefined)} disabled={busy}>Cancel</button>
              </> : <>
                <button className="cm-compare-key" aria-label={`Place ${entry.name}`} onClick={() => place(entry.payload)} disabled={busy}>Place</button>
                <button className="cm-compare-key" aria-label={`Delete ${entry.name}`} onClick={() => setDeleteId(entry.id)} disabled={busy}>Delete</button>
              </>}
            </div>
          ))}
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </dialog>,
    document.body,
  );
}
