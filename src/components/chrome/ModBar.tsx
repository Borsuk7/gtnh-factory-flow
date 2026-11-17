"use client";

import "./chrome.css";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { isCompactViewport, useIsCompactViewport } from "@/lib/compact-view";
import { usePlanLayout } from "@/components/use-plan-layout";
import { leaveLibrary, openLibrary, useLibraryTab } from "@/lib/library/library-tab";
import { isPowerDisplayUnit } from "@/lib/model/rate-unit";
import { useWorkspaceView, writeWorkspaceView } from "@/lib/workspace-view";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { stampOpened } from "@/lib/library/last-open";
import { ensureInteractionHost } from "@/components/flow/clean/interaction";
import { tipAttrs } from "@/components/flow/clean/interaction";
import { isEditableKeyboardTarget } from "@/components/flow/keyboard";
import { downloadPlanFile } from "@/lib/import-export/open-plan-file";
import { PastePlanDialog } from "@/components/export/PastePlanDialog";
import { BarKey, useBarFit, useTopBarFit } from "./bar-parts";
import { AccountKey } from "./AccountKey";
import { ChromeMenu, chromeAnchorOf, type ChromeAnchor, type MenuEntry } from "./ChromeMenu";
import { knock, OPEN_FEEDBACK_EVENT, OPEN_TOUR_EVENT, OPEN_CONTROLS_EVENT } from "./chrome-events";
import { ModTabs } from "./ModTabs";
import { TOP_BAR_STEPS } from "./top-bar-fold";
import { libraryRows } from "./library-rows";
import { copyPlanCode, copyPlanLink, openInModRow, useModReach } from "./share-actions";
import type { ShareMode } from "@/components/community/SharePlanDialog";
import { PixelIcon } from "./pixel-icons";
import { ControlsList } from "./ControlsList";
import { HelpLinks } from "./help-links";
import { isLiveConfigured } from "@/lib/live/live-config";
import { areOnlineFeaturesEnabled } from "@/lib/online-features";
import { useCommunityAuthStore } from "@/store/community-auth-store";
import { useLiveSession } from "@/store/live-session";
import { closeFeedback, useFeedbackOpen } from "@/components/flow/clean/feedback/feedback-store";
import { PlanShareDialog } from "@/components/live/PlanShareDialog";
import { initialsOf, inkOn } from "@/components/live/LiveFaces";

/** Live plans (sharing, presence, task boards): none of it shows without NEXT_PUBLIC_LIVE_URL. */
const LIVE = isLiveConfigured();

function useHistoryShortcuts() {
  const undo = useFactoryStore((state) => state.undo);
  const redo = useFactoryStore((state) => state.redo);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
      // Typing owns its own history: Ctrl+Z in a rename field or note undoes the typing, not the board.
      if (isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redo, undo]);
}

export interface ModBarProps {
  /** Opens the library dialog: a new post, an update of the plan's own post, or another post of it. */
  onShare: (mode?: ShareMode) => void;
  /** Opens the screenshot panel. */
  onScreenshot: () => void;
  /** Opens the settings box. */
  onSettings: () => void;
  /** Opens the release notes. */
  onChangelog: () => void;
  /** Opens the dev menu (shift-click on the help key). */
  onDevMenu: () => void;
  /** The release notes carry something unread. */
  unreadNotes: boolean;
}

/**
 * The top bar holds the account's things only: the plan tabs and +, the live state and faces, then Plans (the library
 * on My plans; Shared with me and Community are its shelves) and Share (Invite people first, then the copies), the
 * account key, and feedback, settings and help, all on one row that never wraps and never hides a key in a menu: short of
 * room the tabs give way, then Plans, Share and Sign in become icon keys, then the gaps tighten (`useTopBarFit`). Its keys
 * are flat like the tabs and + (chrome.css), the picture keys and the face bare until hovered. What edits or views the board (Non-recipe, undo and redo, Arrange, Fit,
 * the rate unit, EU/t, Avg) is the board's own toolbar (BoardToolbar), along the top of the board.
 */
export function ModBar({ onShare, onScreenshot, onSettings, onChangelog, onDevMenu, unreadNotes }: ModBarProps) {
  useHistoryShortcuts();
  useEffect(() => ensureInteractionHost(), []);
  const barRef = useRef<HTMLElement | null>(null);
  const phoneFit = useBarFit(barRef);
  // The library's "last open" and its most-recent-first order.
  const activeDesignId = useDesignStore((state) => state.activeDesignId);
  useEffect(() => {
    if (activeDesignId) stampOpened(activeDesignId);
  }, [activeDesignId]);
  const setPowerDisplayUnit = useFactoryStore((state) => state.setPowerDisplayUnit);
  const workspace = useWorkspaceView();
  // A phone: the two side columns are drawers over the board, one at a time; their keys sit first in the bar.
  const compact = useIsCompactViewport();
  const planLayout = usePlanLayout();
  const bothOpen = workspace.leftPanelOpen && workspace.rightPanelOpen;
  const itemsOpen = workspace.leftPanelOpen && !bothOpen;
  const sideOpen = workspace.rightPanelOpen && !bothOpen;
  const library = useLibraryTab();
  const isReadOnly = useFactoryStore((state) => state.isReadOnly);
  const feedbackOpen = useFeedbackOpen();
  const [menu, setMenu] = useState<{ kind: "share" | "help"; anchor: ChromeAnchor }>();
  const [pasting, setPasting] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const signedIn = useCommunityAuthStore((state) => Boolean(state.user));
  const username = useCommunityAuthStore((state) => state.user?.username ?? "");
  const faces = useLiveSession((state) => (state.status === "off" ? 0 : state.present.length));
  // One row, nothing in a menu: short of room the tabs give way, then Plans, Share and Sign in become icon keys, then the
  // gaps tighten (top-bar-fold.ts). A phone keeps its words and wraps (chrome.css), with its own give-way (useBarFit).
  const step = useTopBarFit(barRef, { enabled: !compact, layoutKey: `${username}|${faces}` });
  const fit = compact ? phoneFit : TOP_BAR_STEPS[step];
  const tight = compact ? phoneFit !== "roomy" : step === 2;
  const pictures = !compact && step >= 1;
  const closeMenu = useCallback(() => setMenu(undefined), []);

  // The power unit comes back from storage (the old toolbar restored it; it is gone from plan boards).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("gtnh-factory-flow.power-display-unit.v1");
      // A tier saved by the older global unit becomes the mod's per-machine Amps.
      if (isPowerDisplayUnit(saved)) setPowerDisplayUnit(saved === "eu" ? "eu" : "amps");
    } catch {
      /* EU/t when storage is unavailable. */
    }
  }, [setPowerDisplayUnit]);

  // Other parts of the app open the controls list through its door.
  useEffect(() => {
    const open = (event: Event) => {
      event.preventDefault();
      setControlsOpen(true);
    };
    window.addEventListener(OPEN_CONTROLS_EVENT, open);
    return () => window.removeEventListener(OPEN_CONTROLS_EVENT, open);
  }, []);

  const linkedPost = useFactoryStore((state) => state.project.metadata?.communityPlanId);
  const plan = () => useFactoryStore.getState().project;
  const isTaskBoardPlan = useFactoryStore((state) => state.project.primaryView === "tasks");
  // Whether a game with the mod is listening, asked each time the menu opens.
  const modReach = useModReach(menu?.kind === "share");

  // The mod's Share menu has the same rows, in the same words. Labels only. People first, then the copies; a copy
  // posted to Community is the last row (never for a task board).
  const shareEntries: MenuEntry[] = [
    ...(LIVE
      ? [
          {
            label: "Invite people...",
            disabled: !signedIn,
            tip: signedIn ? undefined : "Sign in to invite people",
            onSelect: () => setInviting(true),
          } satisfies MenuEntry,
        ]
      : []),
    { label: "Copy plan link", ruleAbove: LIVE, onSelect: () => void copyPlanLink(plan()) },
    { label: "Copy plan code", onSelect: () => void copyPlanCode(plan()) },
    { label: "Export plan file", onSelect: () => downloadPlanFile(plan()) },
    { label: "Screenshot...", onSelect: onScreenshot },
    openInModRow(modReach, plan),
    ...libraryRows(Boolean(linkedPost), onShare, { disabled: isReadOnly, taskBoard: isTaskBoardPlan }).map(({ detail, ...row }, index) => {
      void detail;
      return index === 0 ? { ...row, ruleAbove: true } : row;
    }),
  ];

  const openMenuFrom = (kind: "share" | "help", event: MouseEvent<HTMLElement>) => {
    const anchor = chromeAnchorOf(event.currentTarget);
    setMenu((current) => (current?.kind === kind ? undefined : { kind, anchor }));
  };

  return (
    <>
      <header ref={barRef} className="mb" data-mod-bar="" data-fit={fit} data-help-anchor="plan-actions">
      <ModTabs onPaste={() => setPasting(true)} onShare={onShare} />
      {LIVE ? <LivePresence tight={tight} /> : null}
      {compact ? (
        <>
          <BarKey
            id="drawer-side"
            label={planLayout ? "Overview" : "Resources"}
            tip={planLayout ? "Overview: inputs, outputs and machines" : "Resources"}
            open={sideOpen}
            onClick={() =>
              writeWorkspaceView(sideOpen ? { rightPanelOpen: false } : { rightPanelOpen: true, leftPanelOpen: false })
            }
          />
          <BarKey
            id="drawer-items"
            label="Items"
            tip="Items: search and place recipes"
            open={itemsOpen}
            onClick={() =>
              writeWorkspaceView(itemsOpen ? { leftPanelOpen: false } : { leftPanelOpen: true, rightPanelOpen: false })
            }
          />
        </>
      ) : null}
      <BarKey
        id="plans"
        gap
        label={pictures ? undefined : "Plans"}
        icon={pictures}
        ariaLabel="Plans"
        width={pictures ? undefined : 42}
        open={library.active}
        tip={areOnlineFeaturesEnabled() ? "Plans: your plans, the ones shared with you, and Community" : "Plans saved in this browser"}
        // Opens the library on My plans, and shuts it again; its shelves are along its top.
        onClick={() => (library.active ? leaveLibrary() : openLibrary({ kind: "all" }))}
      >
        {pictures ? <PixelIcon name="plans" /> : undefined}
      </BarKey>
      <BarKey
        id="share"
        label={pictures ? undefined : "Share"}
        icon={pictures}
        ariaLabel="Share"
        width={pictures ? undefined : 42}
        tip={areOnlineFeaturesEnabled() ? "Share this plan: invite people to edit it with you, or send a copy" : "Share a copy of this plan"}
        open={menu?.kind === "share"}
        onClick={(event) => openMenuFrom("share", event)}
        menuAnchor
      >
        {pictures ? <PixelIcon name="share" /> : undefined}
      </BarKey>
      {areOnlineFeaturesEnabled() ? <AccountKey pictures={pictures} /> : null}
      <BarKey
        id="feedback"
        gap
        icon
        open={feedbackOpen}
        ariaLabel="Feedback"
        tip="Feedback: report a bug, share an idea, or ask for help"
        onClick={() => {
          if (feedbackOpen) {
            closeFeedback();
            return;
          }
          if (!areOnlineFeaturesEnabled() || !knock(OPEN_FEEDBACK_EVENT)) window.open(HelpLinks.bugReport, "_blank", "noopener,noreferrer");
        }}
      >
        <PixelIcon name="bug" className="mb-bug" />
      </BarKey>
      <BarKey id="settings" icon ariaLabel="Settings" tip="Settings" onClick={onSettings}>
        <PixelIcon name="gear" />
      </BarKey>
      <BarKey
        id="help"
        icon
        ariaLabel="Help"
        tip="Help: the tour, and every control"
        open={menu?.kind === "help"}
        onClick={(event) => {
          if (event.shiftKey) {
            onDevMenu();
            return;
          }
          openMenuFrom("help", event);
        }}
        menuAnchor
      >
        <PixelIcon name="help" />
      </BarKey>
      {menu?.kind === "share" ? (
        <ChromeMenu anchor={menu.anchor} entries={shareEntries} label="Share this plan" minWidth={110} align="right" onClose={closeMenu} />
      ) : null}
      {menu?.kind === "help" ? (
        <ChromeMenu
          anchor={menu.anchor}
          entries={helpEntries({
            onChangelog,
            unreadNotes,
            openControls: () => setControlsOpen(true),
          })}
          label="Help"
          minWidth={190}
          align="right"
          onClose={closeMenu}
        />
      ) : null}
      {controlsOpen ? <ControlsList onClose={() => setControlsOpen(false)} /> : null}
      </header>
      {/* Outside the bar: its stacking context (z 30) would put the box under the side columns and drawers. */}
      {pasting ? <PastePlanDialog onClose={() => setPasting(false)} /> : null}
      {inviting ? <PlanShareDialog onClose={() => setInviting(false)} /> : null}
    </>
  );
}

const LIVE_STATUS_TIP: Record<"live" | "connecting" | "offline", string> = {
  live: "Live: every edit is saved as you make it",
  connecting: "Connecting to the live plan",
  offline: "Offline: your edits are kept here and go when the connection is back",
};

/**
 * Whether the open plan is live, and the faces of everyone else in it (one per account, initials in their colour),
 * at the end of the tab strip as the mod draws them. Nothing while the plan is not live.
 */
function LivePresence({ tight }: { tight: boolean }) {
  const status = useLiveSession((state) => state.status);
  const present = useLiveSession((state) => state.present);
  const pending = useLiveSession((state) => state.pending);
  if (status === "off") return null;
  // A narrow bar keeps the first two faces and counts the rest.
  const shown = present.slice(0, tight ? 2 : 5);
  const more = present.length - shown.length;
  const waiting = status !== "live" && pending > 0 ? ` (${pending} waiting)` : "";
  return (
    <div
      className="mb-live"
      data-live-status={status}
      {...tipAttrs({
        id: "bar|live",
        title: `${LIVE_STATUS_TIP[status]}${waiting}`,
        sub: present.length > 0 ? `Here now: ${present.map((person) => person.username).join(", ")}` : undefined,
      })}
    >
      <span className="mb-live-dot" data-status={status} aria-hidden />
      {shown.length > 0 ? (
        <span className="mb-faces" data-live-faces="">
          {shown.map((person) => (
            <span
              key={person.id}
              className="mb-face"
              aria-label={person.client === "game" ? `${person.username} (in game)` : person.username}
              style={{ background: person.color, color: inkOn(person.color) }}
            >
              {initialsOf(person.username)}
            </span>
          ))}
          {more > 0 ? <span className="mb-face mb-face-more">+{more}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function helpEntries({
  onChangelog,
  unreadNotes,
  openControls,
}: {
  onChangelog: () => void;
  unreadNotes: boolean;
  openControls: () => void;
}): MenuEntry[] {
  return [
    // The tour needs the full layout: on a compact one it is not offered rather than doing nothing.
    ...(isCompactViewport()
      ? []
      : [
          {
            label: "Take the tour",
            detail: "3 minutes",
            onSelect: () => {
              // The tour lives in its own package; with nothing listening yet the knock goes unanswered.
              knock(OPEN_TOUR_EVENT);
            },
          },
        ]),
    { label: "Controls and shortcuts", onSelect: openControls },
    { label: "Welcome", ruleAbove: true, onSelect: () => HelpLinks.openWelcome() },
    { label: unreadNotes ? "What's new *" : "What's new", detail: HelpLinks.version, onSelect: onChangelog },
    { label: "Download the mod", detail: "GTNH 2.9", onSelect: () => HelpLinks.open(HelpLinks.mod) },
  ];
}
