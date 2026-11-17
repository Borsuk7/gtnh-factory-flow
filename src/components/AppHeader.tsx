"use client";

import "./app-chrome.css";

import { useEffect, useState, useSyncExternalStore } from "react";
import { OPEN_SHARE_DIALOG_EVENT } from "@/lib/setups-tab";
import { markNotesReadAndNotify, subscribeToNotesRead, unseenEntries } from "@/lib/whats-new";
import { ChangelogDialog } from "./ChangelogDialog";
import { ModAnnouncement } from "./ModAnnouncement";
import { SharePlanDialog, type ShareMode } from "./community/SharePlanDialog";
import { ModScreenshot } from "./chrome/ModScreenshot";
import { DevMenu } from "./DevMenu";
import { ModSettings } from "./chrome/ModSettings";
import { ModBar } from "./chrome/ModBar";

/**
 * The pack picker's switch. See the note where it renders; flip this back to
 * true when there is more than one pack to pick from.
 */
export const SHOW_PACK_PICKER = false;

interface AppHeaderProps {
  onLoadDatasetVersion: (versionId: string) => void;
}

/**
 * The one top bar for the whole app: title and version chip, design tabs,
 * plan actions, settings, links and account.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the pack picker is hidden (SHOW_PACK_PICKER); the prop stays wired
export function AppHeader(_props: AppHeaderProps) {
  // The chip wears a dot while a shipped release has notes this browser has
  // not opened. It has its own stamp, separate from the release notice's
  // (see whats-new.ts).
  const hasUnread = useSyncExternalStore(
    subscribeToNotesRead,
    () => unseenEntries().length > 0,
    () => false,
  );
  // Captured at the moment of the click, because opening the notes marks them
  // read: without this the sheet would have nothing above its divider.
  const [unseenVersions, setUnseenVersions] = useState<Set<string>>();
  const [isChangelogOpen, setChangelogOpen] = useState(false);
  // Shift-click the version chip. See DevMenu.
  const [isDevMenuOpen, setDevMenuOpen] = useState(false);
  // The share dialog lives up here rather than in BoardActions so the compact
  // menu can close behind it without unmounting it. The export dialog for the
  // same reason.
  // Open with the mode the Share menu asked for (Save, Update, Save as new post); `false` when closed.
  const [shareMode, setShareMode] = useState<ShareMode | undefined | false>(false);
  const [isExportOpen, setExportOpen] = useState(false);
  // The shelf asks for the share dialog by event after putting a design on
  // the canvas ("Update post"): same dialog, same board, no second copy.
  useEffect(() => {
    const open = (event: Event) => {
      const mode = (event as CustomEvent<unknown>).detail;
      setShareMode(mode === "save" || mode === "update" || mode === "new" ? mode : undefined);
    };
    window.addEventListener(OPEN_SHARE_DIALOG_EVENT, open);
    return () => window.removeEventListener(OPEN_SHARE_DIALOG_EVENT, open);
  }, []);
  // Settings lives up here for the same reason as the share dialog: the
  // compact menu closes behind it without unmounting it.
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  // Dialogs the bar and the header both open; they portal or sit fixed, so neither layout owns their place.
  const dialogs = (
    <>
      {isChangelogOpen ? (
        <ChangelogDialog unseenVersions={unseenVersions} onClose={() => setChangelogOpen(false)} />
      ) : null}
      {/* The one popup that opens by itself, once per browser. */}
      <ModAnnouncement />
      {isDevMenuOpen ? <DevMenu onClose={() => setDevMenuOpen(false)} /> : null}
      {shareMode !== false ? <SharePlanDialog mode={shareMode} onClose={() => setShareMode(false)} /> : null}
      {isExportOpen ? <ModScreenshot onClose={() => setExportOpen(false)} /> : null}
      {isSettingsOpen ? (
        <ModSettings onClose={() => setSettingsOpen(false)} />
      ) : null}
    </>
  );

  // The mod's bar (src/components/chrome), on every window size: a phone gets it condensed (chrome.css).
  return (
    <>
      <ModBar
        onShare={(mode) => setShareMode(mode)}
        onScreenshot={() => setExportOpen(true)}
        onSettings={() => setSettingsOpen((open) => !open)}
        onChangelog={() => {
          setUnseenVersions(new Set(unseenEntries().map((entry) => entry.version)));
          markNotesReadAndNotify();
          setChangelogOpen(true);
        }}
        onDevMenu={() => setDevMenuOpen(true)}
        unreadNotes={hasUnread}
      />
      {dialogs}
    </>
  );
}
