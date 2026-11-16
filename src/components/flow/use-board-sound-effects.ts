"use client";

import { useEffect } from "react";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";
import { boardFingerprint, snapshotBoard, soundForDiff, type BoardShot, type DiffSound } from "@/lib/sound/board-diff";
import { installBoardGestureSounds, lastWheelStep } from "@/lib/sound/board-gestures";
import { editClaimedNear, installSfxUnlock, playSfx, recentSfx, sfxTick } from "@/lib/sound/sfx";
import { useFactoryStore } from "@/store/factory-store";

/**
 * Plays the board's sounds, the mod's files by the mod's rules (`src/lib/sound/AGENTS.md` has the table):
 *
 * - every edit by WATCHING the plan (`soundForDiff`): a card landing, a wire latching as what it carries, a drawer made,
 *   a pin, a tier, a setting. An edit that sounded for itself (undo, clone, a chip with its own voice) claims it
 *   (`claimEdit`) and the watcher stays quiet; the check waits a task so a claim made just after the edit counts.
 * - a wheel spin ticks each step, and a pin or rate wheeled plays once the wheel has been still for 500 ms (the mod's
 *   `live`).
 * - the hand's sounds (press, lift, drop, wire grab, select) from the page's events (`board-gestures.ts`).
 * - the plan starting to run (`board.running`) when a solve has it running where it did not before.
 *
 * A different plan arriving is navigation and plays nothing, and a short quiet follows it (loading machinery rewrites
 * the plan right after a switch).
 */

/** How long after a plan switch the board stays quiet. */
const QUIET_AFTER_SWITCH_MS = 1200;
/** A plan change this soon after a wheel step came from the wheel. */
const WHEEL_EDIT_MS = 80;
/** The mod's `LIVE_SETTLE_MS`: a wheeled pin sounds once the wheel has been still this long. */
const SETTLE_MS = 500;

/** The plan as the ear knows it, for a gesture's "did anything change" check. */
export function projectSoundFingerprint(project: FactoryProject): string {
  return boardFingerprint(project);
}

function playDiffSound(sound: DiffSound): void {
  playSfx(sound.name, 1, sound.pitch ?? 1);
}

/** Whether an undo or redo played lately (the store plays them as it acts). */
function undoneLately(): boolean {
  const now = performance.now();
  return recentSfx().some((p) => (p.name === "board.undo" || p.name === "board.redo") && now - p.at < 1500);
}

/**
 * Whether the books have the plan running (the mod's `heardRunning`): solved, and some machine working that a pin or
 * rate sets (a part nothing sets, or a machine left unneeded, is not running).
 */
export function isRunning(result: ThroughputResult | undefined): boolean {
  if (!result || result.stale || result.plan?.failure) return false;
  const idle = new Set<string>([...(result.plan?.unneeded ?? []), ...(result.plan?.unanchored ?? [])]);
  for (const [id, node] of Object.entries(result.nodes)) {
    if (node.operationRatePerSecond > 1e-9 && !idle.has(id)) return true;
  }
  return false;
}

export function useBoardSoundEffects(): void {
  useEffect(() => {
    let shot: BoardShot = snapshotBoard(useFactoryStore.getState().project);
    let quietUntil = 0;
    let settleTimer: number | undefined;
    let settleSound: DiffSound | undefined;
    let running = isRunning(useFactoryStore.getState().lastResult);
    let runningOf = useFactoryStore.getState().project.id;

    const settle = (sound: DiffSound) => {
      settleSound = sound;
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        const wheel = lastWheelStep();
        // Still turning: wait for it to stop.
        if (wheel && performance.now() - wheel.at < SETTLE_MS - 20) {
          settle(settleSound ?? sound);
          return;
        }
        if (settleSound) playDiffSound(settleSound);
        settleSound = undefined;
      }, SETTLE_MS);
    };

    const unsubscribe = useFactoryStore.subscribe((state, prevState) => {
      // Stale books (a solve still out) say nothing either way: the plan keeps running until an answer says not.
      const settled = !state.lastResult?.stale;
      if (settled && (state.lastResult !== prevState.lastResult || state.project.id !== runningOf)) {
        const now = isRunning(state.lastResult);
        const fresh = state.project.id === runningOf && performance.now() >= quietUntil;
        // Not on a tab switch or an undo: those plans were running before.
        if (fresh && now && !running && !undoneLately()) playSfx("board.running");
        running = now;
        runningOf = state.project.id;
      }
      if (state.project === prevState.project) return;
      const next = snapshotBoard(state.project);
      const prev = shot;
      shot = next;
      if (next.projectId !== prev.projectId) {
        quietUntil = performance.now() + QUIET_AFTER_SWITCH_MS;
        return;
      }
      if (performance.now() < quietUntil) return;
      const sound = soundForDiff(prev, next);
      if (!sound) return;
      const at = performance.now();
      const wheel = lastWheelStep();
      const wheeled = wheel !== undefined && at - wheel.at < WHEEL_EDIT_MS;
      // A task later, so a control that sounds for itself just after its edit still claims it.
      window.setTimeout(() => {
        if (editClaimedNear(at)) return;
        if (wheeled && wheel) {
          if (sound.name === "dial.tier") playDiffSound(sound);
          else sfxTick(wheel.up);
          if (sound.settles) settle(sound);
          return;
        }
        playDiffSound(sound);
      }, 0);
    });

    // A handle for checking the sounds by hand in development (the plays, newest last, and the running state).
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __sfx?: object }).__sfx = {
        recent: recentSfx,
        running: () => ({ running, runningOf, nodes: Object.values(useFactoryStore.getState().lastResult?.nodes ?? {}).map((n) => n.operationRatePerSecond), stale: useFactoryStore.getState().lastResult?.stale }),
      };
    }
    const stopGestures = installBoardGestureSounds();
    const stopUnlock = installSfxUnlock();
    return () => {
      unsubscribe();
      stopGestures();
      stopUnlock();
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    };
  }, []);
}
