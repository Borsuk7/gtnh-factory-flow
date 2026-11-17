"use client";

import "./chrome.css";

import { useRef, useState } from "react";
import { Eye, X } from "lucide-react";
import { useDeviceSettings } from "@/lib/device-settings";
import { isLiveConfigured } from "@/lib/live/live-config";
import { leaveLibrary } from "@/lib/library/library-tab";
import type { RateUnit } from "@/lib/model/rate-unit";
import { requestNewTask, setTaskView, useTaskView } from "@/lib/tasks/task-board-ui";
import { tipAttrs } from "@/components/flow/clean/interaction";
import { MenuPortal } from "@/components/flow/clean/menus/MenuPortal";
import { BoardViewOptions } from "@/components/flow/BoardViewOptions";
import { useBoardView, writeBoardView } from "@/components/flow/board-view";
import "@/components/tasks/tasks.css";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { arrangeLabel, getBoardCommands, pressArrange, useArrangeState, useBoardMarkup } from "./board-commands";
import { BarKey, useBarFit } from "./bar-parts";
import { ChromeMenu, chromeAnchorOf, type ChromeAnchor } from "./ChromeMenu";
import { BoardMarkup } from "@/components/flow/BoardMarkup";
import { PixelBolt, PixelIcon } from "./pixel-icons";

/** Task boards come with live plans: none of it shows without NEXT_PUBLIC_LIVE_URL. */
const LIVE = isLiveConfigured();

/** The rate unit key's four clocks, in the mod's order. */
const RATE_ORDER: RateUnit[] = ["tick", "second", "minute", "hour"];
const RATE_LABEL: Record<string, string> = { tick: "/t", second: "/s", minute: "/min", hour: "/hr", eu: "/s" };

/** This strip has fewer keys than the top bar: it tightens at its own width (its own px); its two groups wrap by themselves. */
const STRIP_FIT = { tightBelow: 390, foldedBelow: 0 } as const;
const KEEP_GROUPS = {
  label: "Keep groups",
  tip: "Each group moves as one block. What is inside a group stays where it is.",
  onSelect: () => pressArrange(),
};
const UNGROUP_ALL = {
  label: "Ungroup all",
  tip: "Takes every group apart, then arranges all the cards. Undo brings the groups back.",
  onSelect: () => pressArrange({ ungroup: true }),
};

/**
 * The board toolbar sits between the overview and the items list. The right group drops to a second row when
 * space runs out, and each plate keeps its keys together. A task board shows its title and task controls.
 */
export function BoardToolbar() {
  const ref = useRef<HTMLElement | null>(null);
  const fit = useBarFit(ref, STRIP_FIT);
  const isTaskBoard = useFactoryStore((state) => LIVE && state.project.primaryView === "tasks");
  return (
    <header ref={ref} className="mb mb-strip" data-board-toolbar="" data-fit={fit}>
      {isTaskBoard ? <TaskBoardHeader /> : <BoardKeys tight={fit !== "roomy"} />}
    </header>
  );
}

/**
 * A task board's header, as the game's (TaskBoardView.drawHeader): its title and how many tasks it holds as plain
 * words, then Board / Chain (remembered per board in this browser) and New task at the right.
 */
function TaskBoardHeader() {
  const designId = useDesignStore((state) => state.activeDesignId);
  const name = useDesignStore(
    (state) => state.designs.find((entry) => entry.id === state.activeDesignId)?.name,
  );
  const count = useFactoryStore((state) => state.project.tasks?.length ?? 0);
  const isReadOnly = useFactoryStore((state) => state.isReadOnly);
  const view = useTaskView(designId);
  const views = [
    { id: "board", label: "Board", tip: "Show the tasks in columns", sub: undefined },
    {
      id: "chain",
      label: "Chain",
      tip: "Show the tasks as chains",
      sub: "What each task waits on, left to right",
    },
  ] as const;
  return (
    <>
      <div className="mb-group mb-group-left">
        <span className="mb-title" data-plain="" data-task-board-title="">
          {name?.trim() ? name : "Tasks"}
        </span>
        <span className="mb-count" data-plain="">
          {count === 1 ? "1 task" : `${count} tasks`}
        </span>
      </div>
      <div className="mb-group mb-group-right">
        <span className="tb-switch" role="group" aria-label="View" data-task-view-switch="">
          {views.map((each) => (
            <button
              key={each.id}
              type="button"
              aria-pressed={view === each.id}
              data-task-view={each.id}
              {...tipAttrs({ id: `task-view|${each.id}`, title: each.tip, sub: each.sub })}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => designId && setTaskView(designId, each.id)}
            >
              {each.label}
            </button>
          ))}
        </span>
        <BarKey
          id="new-task"
          label="New task"
          off={isReadOnly}
          tip="Add a task to To do"
          onClick={() => requestNewTask()}
        />
      </div>
    </>
  );
}

function BoardKeys({ tight }: { tight: boolean }) {
  // A live plan's undo is its own (recorded inverses of this person's edits): the keys read it when it is set.
  const canUndo = useFactoryStore((state) => (state.liveUndo ? state.liveUndo.canUndo : state.undoHistory.length > 0));
  const canRedo = useFactoryStore((state) => (state.liveUndo ? state.liveUndo.canRedo : state.redoHistory.length > 0));
  const undo = useFactoryStore((state) => state.undo);
  const redo = useFactoryStore((state) => state.redo);
  const rateUnit = useFactoryStore((state) => state.rateUnit);
  const setRateUnit = useFactoryStore((state) => state.setRateUnit);
  const powerDisplayUnit = useFactoryStore((state) => state.powerDisplayUnit);
  const setPowerDisplayUnit = useFactoryStore((state) => state.setPowerDisplayUnit);
  const { scrollChangesValues, keepBoardsOnArrange = true } = useDeviceSettings();
  const powerMenuOpen = useFactoryStore((state) => state.powerMenuOpen);
  const openPowerMenu = useFactoryStore((state) => state.openPowerMenu);
  const closePowerMenu = useFactoryStore((state) => state.closePowerMenu);
  const isReadOnly = useFactoryStore((state) => state.isReadOnly);
  const arrange = useArrangeState();
  const hasGroups = useFactoryStore((state) => (state.project.pockets?.length ?? 0) > 0);
  // A plan with groups asks how to treat them; one without arranges at once.
  const [arrangeMenu, setArrangeMenu] = useState<ChromeAnchor | undefined>(undefined);
  const [optionsAnchor, setOptionsAnchor] = useState<ChromeAnchor | undefined>(undefined);
  const [markupAnchor, setMarkupAnchor] = useState<ChromeAnchor>();
  const markup = useBoardMarkup();
  const painting = markup?.paintMode !== undefined;

  const rateIndex = Math.max(0, RATE_ORDER.indexOf(rateUnit === "eu" ? "second" : rateUnit));
  const stepRate = (step: number) => {
    const next = RATE_ORDER[(rateIndex + step + RATE_ORDER.length) % RATE_ORDER.length];
    setRateUnit(next);
  };

  const isAmps = powerDisplayUnit !== "eu";
  // The mod's Amps: every card counts in its own machine's tier.
  const togglePower = () => setPowerDisplayUnit(isAmps ? "eu" : "amps");

  return (
    <>
      <div className="mb-group mb-group-left">
        <div className="mb-tool-plate">
          <BarKey
            id="nonrecipe"
            glyph="bolt"
            width={tight ? undefined : 78}
            ariaLabel="Non-recipe machines"
            tip="Non-recipe machines: generators, turbines, boilers, reactors"
            open={powerMenuOpen}
            off={isReadOnly}
            onClick={() => {
              // The key opens the picker and closes it again.
              if (powerMenuOpen) closePowerMenu();
              else {
                leaveLibrary();
                openPowerMenu();
              }
            }}
            menuAnchor
          >
            <PixelBolt className="mb-bolt" />
            {tight ? null : "Non-recipe"}
          </BarKey>
        </div>
        <div className="mb-tool-plate">
          <BarKey
            id="undo"
            icon
            off={!canUndo || isReadOnly}
            ariaLabel="Undo"
            tip="Undo (Ctrl+Z)"
            onClick={() => undo()}
          >
            <PixelIcon name="undo" />
          </BarKey>
          <BarKey
            id="redo"
            icon
            off={!canRedo || isReadOnly}
            ariaLabel="Redo"
            tip="Redo (Ctrl+Shift+Z or Ctrl+Y)"
            onClick={() => redo()}
          >
            <PixelIcon name="undo" mirror />
          </BarKey>
        </div>
      </div>
      <div className="mb-group mb-group-right">
        <div className="mb-tool-plate">
          <BarKey
            id="arrange"
            label={arrangeLabel(arrange)}
            width={arrange.running ? 90 : undefined}
            tip="Auto-arrange the plan (press again to stop)"
            off={isReadOnly}
            open={arrangeMenu !== undefined}
            menuAnchor={hasGroups}
            onClick={(event) => {
              setOptionsAnchor(undefined);
              setMarkupAnchor(undefined);
              if (arrange.running || !hasGroups) {
                pressArrange();
              } else if (arrangeMenu) {
                setArrangeMenu(undefined);
              } else {
                setArrangeMenu(chromeAnchorOf(event.currentTarget));
              }
            }}
          />
          {arrangeMenu ? (
            <ChromeMenu
              anchor={arrangeMenu}
              label="Arrange"
              minWidth={110}
              entries={keepBoardsOnArrange
                ? [{ ...KEEP_GROUPS, current: true, detail: "Default" }, UNGROUP_ALL]
                : [{ ...UNGROUP_ALL, current: true, detail: "Default" }, KEEP_GROUPS]}
              onClose={() => setArrangeMenu(undefined)}
            />
          ) : null}
          <BarKey id="fit" label="Fit" width={24} tip="Zoom to fit the whole plan" onClick={() => getBoardCommands()?.fit()} />
        </div>
        <div className="mb-tool-plate">
          <BarKey
            id="rate"
            label={RATE_LABEL[rateUnit] ?? "/s"}
            width={32}
            tip="Rate unit: per tick, second, minute or hour"
            onClick={() => stepRate(1)}
            onContext={() => stepRate(-1)}
            onWheel={scrollChangesValues ? stepRate : undefined}
          />
          <BarKey
            id="power"
            label={isAmps ? "Amps" : "EU/t"}
            width={36}
            tip="Show power as EU/t, or as amps at each machine's tier"
            onClick={togglePower}
            onContext={togglePower}
            onWheel={scrollChangesValues ? togglePower : undefined}
          />
        </div>
        <div className="mb-tool-plate">
          <BarKey
            id="annotate"
            icon
            off={isReadOnly}
            ariaLabel={painting ? "Stop painting" : "Annotations"}
            tip={painting ? "Stop painting" : "Add a sticky note or other markup"}
            tipSub={painting ? "Esc" : undefined}
            menuAnchor={painting ? undefined : "dialog"}
            open={painting || Boolean(markupAnchor && markup)}
            onClick={(event) => {
              if (painting) {
                markup.onPaintModeChange(undefined);
                return;
              }
              setArrangeMenu(undefined);
              setOptionsAnchor(undefined);
              event.currentTarget.focus({ preventScroll: true });
              setMarkupAnchor(markupAnchor ? undefined : chromeAnchorOf(event.currentTarget));
            }}
          >
            {painting ? <X size={12} aria-hidden /> : <PixelIcon name="pencil" />}
          </BarKey>
          {markupAnchor && markup && !isReadOnly ? (
            <MenuPortal
              anchor={markupAnchor}
              align="right"
              width={222}
              maxHeight={420}
              label="Markup tools"
              role="dialog"
              onClose={() => setMarkupAnchor(undefined)}
            >
              <div className="cm-scroll">
                <BoardMarkup tools={markup} onClose={() => setMarkupAnchor(undefined)} />
              </div>
            </MenuPortal>
          ) : null}
          <BarKey
            id="plan-options"
            icon
            ariaLabel="Plan options"
            tip="Plan options"
            menuAnchor="dialog"
            open={optionsAnchor !== undefined}
            onClick={(event) => {
              setMarkupAnchor(undefined);
              if (optionsAnchor) {
                setOptionsAnchor(undefined);
              } else {
                setArrangeMenu(undefined);
                event.currentTarget.focus({ preventScroll: true });
                setOptionsAnchor(chromeAnchorOf(event.currentTarget));
              }
            }}
          >
            <Eye size={12} aria-hidden />
          </BarKey>
          {optionsAnchor ? (
            <PlanOptions
              anchor={optionsAnchor}
              onClose={() => setOptionsAnchor(undefined)}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function PlanOptions({
  anchor,
  onClose,
}: {
  anchor: ChromeAnchor;
  onClose: () => void;
}) {
  const view = useBoardView();
  const planMode = useFactoryStore((state) => state.project.planMode === true);
  return (
    <MenuPortal
      anchor={anchor}
      align="right"
      width={300}
      maxHeight={620}
      label="Plan options"
      role="dialog"
      onClose={onClose}
    >
      <div className="cm-scroll flex flex-col gap-1 p-1.5">
        <BoardViewOptions
          view={view}
          onChange={writeBoardView}
          showOverviewOptions={planMode}
        />
      </div>
    </MenuPortal>
  );
}
