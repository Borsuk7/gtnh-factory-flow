/**
 * The desktop workspace's column arithmetic, kept out of the component so the
 * two layouts can be tested without a DOM.
 *
 * Classic boards: items browser left, board, resource inspector right.
 * Plan-mode boards (`project.planMode`, not Pool): the overview rail left, the
 * board, the items browser right, like NEI beside the mod's board, or the other
 * way round (the settings' "Item browser"). There is no inspector on those.
 * Their two side columns are resizable and give way to the board (`fitPanels`).
 *
 * All lengths are SHELL px.
 */
export const ITEMS_WIDTH = 256;
export const INSPECTOR_WIDTH = 234;
/** Wide enough for one 24px button plus its border. */
export const PANEL_RAIL_WIDTH = 26;

/** The overview's width unless the player drags it: the mod's rail. */
export const OVERVIEW_DEFAULT_WIDTH = 336;
/** Two thirds of the default: its rows (a rule key, a rate box, a name) still read. */
export const OVERVIEW_MIN_WIDTH = 224;
export const OVERVIEW_MAX_WIDTH = 480;
/** The items list's default; its fixed width on a phone's drawer and on classic boards. */
export const ITEMS_DEFAULT_WIDTH = ITEMS_WIDTH;
/** Three item columns (3 slots of 32 and the 6 px margins), which is also the least its page keys need. */
export const ITEMS_MIN_WIDTH = 108;
export const ITEMS_MAX_WIDTH = 420;
/**
 * The least the board keeps while a side column can still give way: the board toolbar on one row with its labels
 * (318 toolbar px including Plan options, 1.7094 shell px each). Measure
 * it again when a key is added to `BoardToolbar`.
 */
export const BOARD_MIN_WIDTH = 545;

export function clampOverviewWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.round(Math.min(OVERVIEW_MAX_WIDTH, Math.max(OVERVIEW_MIN_WIDTH, width)))
    : OVERVIEW_DEFAULT_WIDTH;
}

export function clampItemsWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.round(Math.min(ITEMS_MAX_WIDTH, Math.max(ITEMS_MIN_WIDTH, width)))
    : ITEMS_DEFAULT_WIDTH;
}

export type ItemsSide = "left" | "right";

export interface WorkspaceColumnsInput {
  itemsOpen: boolean;
  /** The inspector column is open. */
  inspectorOpen: boolean;
  /** A page covers the board, or the Pool worksheet is up: nothing reads the board's solve. */
  hideBoardPanels: boolean;
}

export interface WorkspaceColumns {
  itemsSide: ItemsSide;
  leftPx: number;
  rightPx: number;
  /** Whether the classic inspector column holds its panel (not the rail or nothing). */
  inspectorShown: boolean;
  template: string;
}

/** The classic layout: items left, the inspector right, both at their fixed widths. */
export function workspaceColumns(input: WorkspaceColumnsInput): WorkspaceColumns {
  const itemsPx = input.itemsOpen ? ITEMS_WIDTH : PANEL_RAIL_WIDTH;
  const inspectorShown = input.inspectorOpen && !input.hideBoardPanels;
  const rightPx = inspectorShown
    ? INSPECTOR_WIDTH
    : input.hideBoardPanels
      ? 0
      : PANEL_RAIL_WIDTH;
  return {
    itemsSide: "left",
    leftPx: itemsPx,
    rightPx,
    inspectorShown,
    template: `${itemsPx}px minmax(0,1fr) ${rightPx}px`,
  };
}

/** One side column of a plan board, as the player has it. */
export interface PanelWish {
  /** The player's own fold: open unless they folded it. */
  open: boolean;
  /** The player opened it while the window had folded it: it stays open, and the other gives way instead. */
  forced: boolean;
  /** The width the player set (or the default). */
  width: number;
}

export interface PanelFitInput {
  /** The workspace's width. */
  width: number;
  items: PanelWish;
  /** Null under a covering page: the overview is gone, not folded. */
  overview: PanelWish | null;
}

export interface PanelFit {
  itemsOpen: boolean;
  overviewOpen: boolean;
  /** Each column's width, a folded one its strip (the overview 0 when it is gone). */
  itemsPx: number;
  overviewPx: number;
  boardPx: number;
  /** Folded by the window rather than by the player. */
  itemsAutoFolded: boolean;
  overviewAutoFolded: boolean;
}

/**
 * How the side columns share a plan board's width. The board keeps `BOARD_MIN_WIDTH` while a column can still give way,
 * in this order: both columns shrink toward their least (in proportion to what they have over it); then the items
 * list folds to its strip; then the overview does. A fold the window makes never touches the player's own (`open`): it is
 * only this answer, so the column comes back as the window widens. One the player opened against the window
 * (`forced`) is kept and the other folds in its place; with both forced the board takes what is left.
 */
export function fitPanels({ width, items, overview }: PanelFitInput): PanelFit {
  const hasOverview = overview !== null;
  let itemsOpen = items.open;
  let overviewOpen = hasOverview && overview.open;
  const boardAtLeast = () =>
    width -
    (itemsOpen ? ITEMS_MIN_WIDTH : PANEL_RAIL_WIDTH) -
    (hasOverview ? (overviewOpen ? OVERVIEW_MIN_WIDTH : PANEL_RAIL_WIDTH) : 0);
  if (itemsOpen && !items.forced && boardAtLeast() < BOARD_MIN_WIDTH) itemsOpen = false;
  if (overviewOpen && !overview?.forced && boardAtLeast() < BOARD_MIN_WIDTH) overviewOpen = false;

  const wantItems = clampItemsWidth(items.width);
  const wantOverview = hasOverview ? clampOverviewWidth(overview.width) : 0;
  const strips = (itemsOpen ? 0 : PANEL_RAIL_WIDTH) + (hasOverview && !overviewOpen ? PANEL_RAIL_WIDTH : 0);
  const room = Math.floor(width - BOARD_MIN_WIDTH - strips);
  let itemsPx = itemsOpen ? wantItems : PANEL_RAIL_WIDTH;
  let overviewPx = !hasOverview ? 0 : overviewOpen ? wantOverview : PANEL_RAIL_WIDTH;
  if (itemsOpen && overviewOpen) {
    const need = wantItems + wantOverview - room;
    if (need > 0) {
      const slackItems = wantItems - ITEMS_MIN_WIDTH;
      const slackOverview = wantOverview - OVERVIEW_MIN_WIDTH;
      const cutItems = need >= slackItems + slackOverview ? slackItems : Math.round((need * slackItems) / (slackItems + slackOverview));
      const cutOverview = need >= slackItems + slackOverview ? slackOverview : need - cutItems;
      itemsPx = wantItems - cutItems;
      overviewPx = wantOverview - cutOverview;
    }
  } else if (itemsOpen) {
    itemsPx = Math.max(ITEMS_MIN_WIDTH, Math.min(wantItems, room));
  } else if (overviewOpen) {
    overviewPx = Math.max(OVERVIEW_MIN_WIDTH, Math.min(wantOverview, room));
  }
  return {
    itemsOpen,
    overviewOpen,
    itemsPx,
    overviewPx,
    boardPx: width - itemsPx - overviewPx,
    itemsAutoFolded: items.open && !itemsOpen,
    overviewAutoFolded: hasOverview && overview.open && !overviewOpen,
  };
}

/**
 * The most a column can be dragged to: its own limit, or what leaves the board its minimum beside the other column as
 * it is now. Never under its least.
 */
export function panelDragLimits(panel: "items" | "overview", fit: PanelFit, width: number): { min: number; max: number } {
  const min = panel === "items" ? ITEMS_MIN_WIDTH : OVERVIEW_MIN_WIDTH;
  const own = panel === "items" ? ITEMS_MAX_WIDTH : OVERVIEW_MAX_WIDTH;
  const other = panel === "items" ? fit.overviewPx : fit.itemsPx;
  return { min, max: Math.max(min, Math.min(own, Math.floor(width - BOARD_MIN_WIDTH - other))) };
}

/** The plan board's grid: the overview on the left and the items on the right, or the other way round. */
export function planColumns(fit: PanelFit, itemsLeft: boolean): WorkspaceColumns {
  const leftPx = itemsLeft ? fit.itemsPx : fit.overviewPx;
  const rightPx = itemsLeft ? fit.overviewPx : fit.itemsPx;
  return {
    itemsSide: itemsLeft ? "left" : "right",
    leftPx,
    rightPx,
    inspectorShown: false,
    template: `${leftPx}px minmax(0,1fr) ${rightPx}px`,
  };
}

/**
 * Where a full-screen search or picker begins and ends so it leaves the items
 * browser (and, on plan boards, the overview) bright beside it. SHELL px.
 * `classicLeft` is the measured browser width the classic layout already used.
 */
export function overlayInsets(
  scale: number,
  classicLeft: () => number,
  root: ParentNode = document,
): { left: number; right: number } {
  const main = root.querySelector<HTMLElement>("main[data-plan-layout]");
  if (!main) {
    return { left: classicLeft(), right: 0 };
  }
  const left = Number(main.dataset.leftPx) || 0;
  let right = Number(main.dataset.rightPx) || 0;
  if (main.dataset.compact === "true") {
    // The items browser is a drawer here: it leaves what its width covers.
    const aside = root.querySelector<HTMLElement>("aside[data-help-anchor='browser']");
    right = aside ? Math.round(aside.getBoundingClientRect().width / scale) : 0;
  }
  return { left, right };
}
