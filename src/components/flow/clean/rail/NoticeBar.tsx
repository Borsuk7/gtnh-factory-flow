"use client";

import "./rail.css";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useFactoryStore } from "@/store/factory-store";
import { startPromptClock } from "../../virtual/prompt-phase";
import { buildNotices, byUrgency, type BoardNotice, type NoticeSeverity } from "./notices";
import { framesReadably } from "./rail-actions";
import { SparePopupHost } from "./SparePopup";
import { RailTipHost } from "./rail-tip";

/**
 * The notices bar (UI spec section 11): one row each in the mod's anatomy, a
 * stripe in the severity's colour, the sentence, and "Show me", which frames
 * the cards and drawers the notice is about. At most four rows; the rest are
 * counted. Fed by `buildNotices` (the solver's notes in the mod's words) and by
 * `flashNotice` (what a paste or an import did, on top for seven seconds).
 */

export const MAX_NOTICE_ROWS = 4;
const FLASH_MS = 7000;

let flash: (BoardNotice & { until: number }) | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
let flashSnapshot: BoardNotice | undefined;

function emit() {
  flashSnapshot = flash;
  for (const listener of listeners) listener();
}

/** Shows a sentence above the solver's notices for a few seconds. */
export function flashNotice(severity: NoticeSeverity, text: string): void {
  flash = { id: `flash:${text}`, severity, text, focus: [], until: Date.now() + FLASH_MS };
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = undefined;
    emit();
  }, FLASH_MS);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The notices on the board right now, flash first. */
export function useBoardNotices(): BoardNotice[] {
  const project = useFactoryStore((state) => state.project);
  const result = useFactoryStore((state) => state.lastResult);
  const conversion = useFactoryStore((state) => state.planNotice);
  const dismissConversion = useFactoryStore((state) => state.dismissPlanNotice);
  const flashed = useSyncExternalStore(
    subscribe,
    () => flashSnapshot,
    () => undefined,
  );
  const solved = useMemo(() => buildNotices(project, result), [project, result]);
  return useMemo(() => {
    // What a conversion did to an older plan, on one line, until it is dismissed.
    const converted: BoardNotice[] = conversion
      ? [
          {
            id: "conversion",
            severity: "info",
            text: [conversion.text, ...conversion.details].join(" "),
            focus: [],
            dismiss: dismissConversion,
          },
        ]
      : [];
    // A flash answers what the player just did, so it stays on top; the rest go most pressing first.
    return [...(flashed ? [flashed] : []), ...byUrgency([...converted, ...solved])];
  }, [conversion, dismissConversion, flashed, solved]);
}

export function NoticeRow({
  notice,
  onShow,
}: {
  notice: BoardNotice;
  onShow: (notice: BoardNotice) => void;
}) {
  const text = useRef<HTMLSpanElement>(null);
  // The sentence fades out at the end only when the room left clips it.
  useLayoutEffect(() => {
    const el = text.current;
    if (el) el.dataset.clipped = el.scrollWidth > el.clientWidth + 1 ? "" : "no";
  });
  // An alarm blinks off the board's one clock (virtual/prompt-phase.ts), with its ring's card outlines.
  const alarm = notice.tag !== undefined;
  useEffect(() => {
    if (alarm) startPromptClock();
  }, [alarm]);
  return (
    <div
      className="rail-notice"
      data-severity={notice.severity}
      data-alarm={alarm ? (notice.loop ?? "") : undefined}
      role={alarm ? "alert" : "status"}
    >
      {notice.tag ? <span className="rail-notice-tag">{notice.tag}</span> : null}
      <span ref={text} className="rail-notice-text">
        {notice.text}
      </span>
      {notice.focus.length > 0 ? (
        <span
          role="button"
          tabIndex={0}
          className="rail-notice-show"
          onClick={() => onShow(notice)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onShow(notice);
          }}
        >
          Show me
        </span>
      ) : null}
      {notice.dismiss ? (
        <span
          role="button"
          tabIndex={0}
          className="rail-notice-show"
          onClick={notice.dismiss}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") notice.dismiss?.();
          }}
        >
          Dismiss
        </span>
      ) : null}
    </div>
  );
}

/** The stack itself, for the board's notice corner. Renders nothing with no notices. */
export function PlanNoticeStack() {
  const notices = useBoardNotices();
  const turns = useRef(new Map<string, number>());
  const frame = useFactoryStore((state) => state.frameBoardNodes);

  const show = (notice: BoardNotice) => {
    const focus = notice.focus;
    if (focus.length === 0) return;
    // All at once while that still reads; else one at a time, in turn, close enough to read.
    if (focus.length === 1 || framesReadably(focus)) {
      frame(focus, { padding: 0.2 });
      return;
    }
    const next = turns.current.get(notice.id) ?? 0;
    turns.current.set(notice.id, next + 1);
    frame([focus[next % focus.length]!], { maxZoom: 1 });
  };

  if (notices.length === 0) return null;
  const rows = notices.slice(0, MAX_NOTICE_ROWS);
  const more = notices.length - rows.length;
  return (
    <div className="rail-notices nodrag pointer-events-auto" data-help-anchor="notices">
      {rows.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} onShow={show} />
      ))}
      {more > 0 ? (
        <div className="rail-notice rail-notice-more">
          <span className="rail-notice-text">+{more} more</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the plan-mode board mounts in its notice corner: the notices, and the
 * two floating pieces that belong with them (the spare popup a card's Forced
 * row opens, and the rail's tooltip).
 */
export function PlanBoardOverlays() {
  return (
    <>
      <PlanNoticeStack />
      <SparePopupHost />
      <RailTipHost />
    </>
  );
}

/**
 * The board's notice corner has two dresses: plan-mode boards get the mod's
 * notices bar (`plan`), every other board keeps its classic notices (children).
 */
export function PlanNoticeSwitch({ children }: { children: ReactNode }) {
  const planMode = useFactoryStore((state) => state.project.planMode === true);
  return planMode ? null : <>{children}</>;
}

/**
 * The plan-mode notices, stacked at the TOP of the board as the mod stacks them (under its top bar), left aligned and
 * just below the board's toolbars so they never cover a key. Mounted once, beside the board's other overlays.
 */
export function PlanTopNotices() {
  const planMode = useFactoryStore((state) => state.project.planMode === true);
  if (!planMode) return null;
  return (
    <div className="rail-notices-top nodrag pointer-events-none absolute z-30">
      <PlanBoardOverlays />
    </div>
  );
}
