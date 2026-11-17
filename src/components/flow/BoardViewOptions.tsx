"use client";

import { Activity, AlignJustify, Ban, Grid2x2, Grid3x3, Grip, Magnet, Minus, Network, Plus, ScanLine, type LucideIcon } from "lucide-react";
import { useDeviceSettings, writeDeviceSettings } from "@/lib/device-settings";
import { useBoardMotion, writeBoardMotion } from "./board-motion";
import { CANVAS_PATTERNS, CANVAS_PATTERN_LABEL, type BoardView, type CanvasPattern } from "./board-view";
import { CANVAS_THEMES, type CanvasTheme } from "./canvas-themes";

export const TOOL_FACE_ON = "bg-[var(--mc-85)] text-[var(--mc-ink)] shadow-[inset_2px_2px_0_var(--mc-100)]";
export const TOOL_FACE_OFF =
  "bg-[var(--mc-49)] text-white shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25)] hover:brightness-110";

/** One glyph per background pattern, for the view menu's pattern row. */
const CANVAS_PATTERN_ICON: Record<CanvasPattern, LucideIcon> = {
  dots: Grip,
  lines: Grid3x3,
  cross: Plus,
  ruled: AlignJustify,
  graph: Grid2x2,
  none: Ban,
};

/** A theme row's little preview: its paper, its texture, three of its dots. */
function ThemeSwatch({ theme }: { theme: CanvasTheme }) {
  return (
    <span
      aria-hidden
      className="flex h-7 w-11 shrink-0 items-center justify-center gap-1 border border-[var(--mc-15)]"
      style={{ backgroundColor: theme.base, backgroundImage: theme.texture }}
    >
      {[0, 1, 2].map((dot) => (
        <span key={dot} className="h-[3px] w-[3px]" style={{ backgroundColor: theme.patternColor }} />
      ))}
    </span>
  );
}

/** View settings and Arrange use the same controls in both toolbars. */
export function BoardViewOptions({
  view,
  onChange,
  showOverviewOptions = false,
  keepBoardsByDefault = false,
  arrangeDisabled = false,
  onArrange,
}: {
  view: BoardView;
  onChange: (patch: Partial<BoardView>) => void;
  showOverviewOptions?: boolean;
  keepBoardsByDefault?: boolean;
  arrangeDisabled?: boolean;
  onArrange: (keepBoards: boolean) => void;
}) {
  const { canvasPattern } = view;
  const settings = useDeviceSettings();
  const boardMotion = useBoardMotion();
  const keepBoards = settings.keepBoardsOnArrange ?? keepBoardsByDefault;
  const toggles: Array<{
    id: string;
    on: boolean;
    label: string;
    line?: string;
    Icon: LucideIcon;
    flip: () => void;
  }> = [
    {
      id: "fixed-edge-width",
      on: view.fixedEdgeWidth,
      label: "Fixed edge width",
      Icon: Minus,
      flip: () => onChange({ fixedEdgeWidth: !view.fixedEdgeWidth }),
    },
    // The two motion switches: device taste, so they write to their own store
    // and never travel with a shared plan.
    {
      id: "smooth",
      on: boardMotion.moveMotion,
      label: "Smooth movement",
      line: "Cards move smoothly instead of jumping.",
      Icon: Magnet,
      flip: () => writeBoardMotion({ moveMotion: !boardMotion.moveMotion }),
    },
    {
      id: "numbers",
      on: boardMotion.valueMotion,
      label: "Live numbers",
      line: "Numbers change smoothly.",
      Icon: Activity,
      flip: () => writeBoardMotion({ valueMotion: !boardMotion.valueMotion }),
    },
  ];
  if (showOverviewOptions) {
    toggles.push({
      id: "follow-selection",
      on: settings.overviewFollowsSelection,
      label: "Follow selection in Overview",
      line: "Show resources for the selected cards and drawers.",
      Icon: ScanLine,
      flip: () => writeDeviceSettings({ overviewFollowsSelection: !settings.overviewFollowsSelection }),
    });
  }

  return (
    <>
      {/* The background's paper... */}
      <div className="grid grid-cols-2 gap-1">
        {CANVAS_THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            onClick={() => onChange({ canvasTheme: theme.id })}
            className={[
              "flex items-center gap-2 border-2 p-1 text-left",
              view.canvasTheme === theme.id
                ? "border-white bg-[var(--mc-85)] ring-2 ring-cyan-300"
                : "border-[var(--mc-15)] bg-[var(--mc-49)] hover:bg-[var(--mc-61)]",
            ].join(" ")}
            aria-label={`Background style: ${theme.name}`}
            aria-pressed={view.canvasTheme === theme.id}
          >
            <ThemeSwatch theme={theme} />
            <span className="min-w-0 truncate text-[11px] font-semibold leading-tight text-[var(--mc-ink)]">
              {theme.name}
            </span>
          </button>
        ))}
      </div>
      {/* ...and its pattern, one key per choice. */}
      <div className="flex gap-1">
        {CANVAS_PATTERNS.map((pattern) => {
          const PatternIcon = CANVAS_PATTERN_ICON[pattern];
          return (
            <button
              key={pattern}
              type="button"
              onClick={() => onChange({ canvasPattern: pattern })}
              title={CANVAS_PATTERN_LABEL[pattern]}
              aria-label={`Background pattern: ${CANVAS_PATTERN_LABEL[pattern]}`}
              aria-pressed={canvasPattern === pattern}
              className={[
                "flex h-9 flex-1 items-center justify-center border-2 border-[var(--mc-15)]",
                canvasPattern === pattern ? TOOL_FACE_ON : TOOL_FACE_OFF,
              ].join(" ")}
            >
              <PatternIcon className="h-4 w-4" />
            </button>
          );
        })}
      </div>
      {/* No grid or line-colour rows: the grid is always on, and colour
          by speed is the smart view's switch, bottom right. */}
      {toggles.map(({ id, on, label, line, Icon, flip }) => (
        <button
          key={id}
          type="button"
          onClick={flip}
          aria-label={label}
          aria-pressed={on}
          className={[
            "flex items-start gap-2 border-2 p-2 text-left",
            on
              ? `border-[var(--mc-good)] ${TOOL_FACE_ON}`
              : `border-[var(--mc-15)] ${TOOL_FACE_OFF}`,
          ].join(" ")}
        >
          <Icon className="mt-[1px] h-4 w-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[12px] font-black uppercase">{label}</span>
              <span
                className={[
                  "font-mono text-[10px] font-black tracking-[1px]",
                  on ? "text-[var(--mc-good)]" : "text-[var(--mc-ink-muted)]",
                ].join(" ")}
              >
                {on ? "ON" : "OFF"}
              </span>
            </span>
            {line ? <span className="font-mono text-[11px] leading-snug opacity-80">{line}</span> : null}
          </span>
        </button>
      ))}
        <div className="mt-1 border-t-2 border-[var(--mc-15)] pt-1">
        <button
          type="button"
          onClick={() => writeDeviceSettings({ keepBoardsOnArrange: !keepBoards })}
          aria-label="Keep boards on rearrange"
          aria-pressed={keepBoards}
          className={[
            "flex w-full items-start gap-2 border-2 p-2 text-left",
            keepBoards
              ? `border-[var(--mc-good)] ${TOOL_FACE_ON}`
              : `border-[var(--mc-15)] ${TOOL_FACE_OFF}`,
          ].join(" ")}
        >
          <Network className="mt-[1px] h-4 w-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[12px] font-black uppercase">Keep boards on rearrange</span>
              <span
                className={[
                  "font-mono text-[10px] font-black tracking-[1px]",
                  keepBoards ? "text-[var(--mc-good)]" : "text-[var(--mc-ink-muted)]",
                ].join(" ")}
              >
                {keepBoards ? "ON" : "OFF"}
              </span>
            </span>
          </span>
        </button>
        <button
          type="button"
          disabled={arrangeDisabled}
          onClick={() => onArrange(keepBoards)}
          className="mt-1 flex w-full items-center justify-center gap-2 border-2 border-[var(--mc-15)] bg-[var(--mc-49)] p-2 font-mono text-[12px] font-black uppercase text-white shadow-[inset_2px_2px_0_var(--mc-85),inset_-2px_-2px_0_var(--mc-25)] hover:brightness-110 disabled:opacity-50"
          aria-label="Arrange the board"
        >
          <Network className="h-4 w-4" />
          Arrange
        </button>
      </div>
    </>
  );
}
