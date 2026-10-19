/**
 * Contracts of the merged ("plan mode") solver, frozen by WP0.
 *
 * Sections 1 and 2 of the solver port spec (`SolveInput`, `Answer`,
 * `SolutionView`, alternatives, spares, notes) and the adapter's
 * `PlanSolveExtras` (what the board reads off `ThroughputResult.plan`).
 * The engine works in the mod's slot-indexed world (ports are positions in
 * a machine's port lists); the extras speak the website's row keys (`PortKey`)
 * because indices are not stable across solves here. Changes to this file
 * go through the integrator.
 */

/**
 * Opaque unique id. Needs a total order: `compareIds` in `ids.ts` (Java signed
 * UUID order for UUIDs), never a plain string sort.
 */
export type Id = string;

/** One port of a machine. Units are per craft BEFORE the machine's parallels and multipliers. */
export interface PortIn {
  /** Units per craft (items, or mB for fluids; fractional allowed). Negative reads as 0. */
  amount: number;
  /** 0..1, a 32-bit float in the Java: `Math.fround()` it when reading. */
  chance: number;
  /** The node's own consumption (inputs) / productivity (outputs) multiplier on this port. */
  multiplier: number;
  /**
   * Ingredient number shared by every port that can connect to each other.
   * Used only by the wiring diagnostics and the stored-choice fallback.
   */
  resource: number;
  /** Ingredient display name; only used in notes. */
  name: string;
  /** The pack gives this ingredient away; silences the wiring diagnostics for it. */
  free: boolean;
}

export interface MachineIn {
  id: Id;
  /** Card/machine display name; only used in notes. */
  name: string;
  /** Ticks per craft after overclock (20 ticks = 1 s). <= 0 reads as 1. */
  durationTicks: number;
  /** NOT read by the solver; kept for the read-out. */
  energyPerTick: number;
  /** Crafts run at once per machine (parallels). Multiplies every port quantity. */
  throughputFactor: number;
  inputs: PortIn[];
  outputs: PortIn[];
  /** The machine count is pinned (a hard pin). */
  countFixed: boolean;
  /** The pin when `countFixed`. 0 with `countFixed` means "must not run". */
  machineCount: number;
  /** Output port index -> units/s the player asked of that port. */
  targetOutputRates: Record<number, number>;
  /** Input port index -> units/s the player asked of that port. */
  targetInputRates: Record<number, number>;
}

export interface EdgeIn {
  id: Id;
  source: Id;
  sourceOutput: number;
  target: Id;
  targetInput: number;
}

/** A machine group with a capacity. Only groups with `capacity > 0` are passed. */
export interface PoolIn {
  machines: Id[];
  /** Machines. */
  capacity: number;
  /** false: a cap (sum of machine time <= capacity). true: the count is pinned (== capacity). */
  exact: boolean;
  /**
   * The Up to rule (docs/up-to.md), read only when `exact` is false: the machines run as hard as the plan lets them,
   * never above `capacity`, and no forced flow makes up what they cannot do. Anchors its part of the plan. A one-card
   * pool is how a single card's Up to pin reaches the engine. Absent = false (a plain cap, the mod's older groups).
   */
  upTo?: boolean;
}

export type DrawerKind = "SOURCE" | "PRODUCT" | "BYPRODUCT" | "TRASH" | "BUFFER";
export type DrawerRule = "ANY" | "AT_LEAST" | "EXACTLY" | "AT_MOST";

/** SOURCE links point at INPUT ports, every other kind at OUTPUT ports; a BUFFER's `takers` are INPUT ports. */
export interface DrawerLink {
  node: Id;
  port: number;
}

export interface DrawerIn {
  id: Id;
  /** The drawer's label, else its resource key; only used in notes. */
  label: string;
  kind: DrawerKind;
  /** Already the EFFECTIVE rule: ANY for TRASH/BYPRODUCT whatever they store. */
  rule: DrawerRule;
  /** Units/s (L/s for fluids); meaningless under ANY. */
  rate: number;
  links: DrawerLink[];
  /**
   * A BUFFER's users: the input ports it feeds (its `links` are the output ports feeding it). Absent or empty for
   * every other kind, as in the mod's dump (`SolveInputJson` writes it only when non-empty).
   */
  takers?: DrawerLink[];
}

export interface PortRef {
  node: Id;
  port: number;
  input: boolean;
}

export interface SolveInput {
  /** Other modes are not ported. */
  mode: "AUTO";
  /** A stored gate choice (a ChoiceKey's anchors) to honour. */
  choice?: PortRef[] | null;
  /** ORDER MATTERS: machines in id order. */
  machines: MachineIn[];
  /** ORDER MATTERS. */
  edges: EdgeIn[];
  pools: PoolIn[];
  drawers: DrawerIn[];
  /** Extra per-machine pins in CRAFTS per second; the app passes {} (a test hook). */
  extentPins: Record<Id, number>;
  /** Stored leftover splits: leftover key -> bearer key -> share. */
  spares: Record<string, Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type SolverMessage =
  | "NO_PIN"
  | "EMPTY_GRAPH"
  | "BALANCE_FAILED"
  | "STAGE_FAILED"
  | "VALIDATION_FAILED"
  | "PIN_CONFLICT"
  | "PIN_DROPPED"
  | "PIN_COUNT"
  | "PIN_TARGET"
  | "PIN_EXTENT"
  | "PIN_UP_TO"
  | "SOLVER_UNSATISFIABLE"
  | "SOLVER_BUDGET"
  | "SOLVER_NOT_CONSERVING"
  | "OVERSHOOTS_TARGET"
  | "DRAWER_NOT_CONNECTED"
  | "DRAWER_WIRED_IGNORED"
  | "DRAWER_ONLY_UPPER_BOUNDS"
  | "DRAWER_UNMET"
  | "DRAWER_LIMITED_BY"
  | "RULE_ANY"
  | "RULE_AT_LEAST"
  | "RULE_EXACTLY"
  | "RULE_AT_MOST"
  | "LIMIT_PIN"
  | "LIMIT_DRAWER"
  | "LIMIT_GROUP"
  | "WIRING_IMPORT"
  | "WIRING_UNLINKED"
  | "CHOICE_NO_LONGER_FITS"
  | "CHOICE_NEEDS_MORE_GATES"
  | "SHOWING_CLOSEST"
  | "STOPPED_EARLY";

export type NoteArg = string | number | Note | Note[];

/** Never a rendered string: goldens record `message` as the enum name. */
export interface Note {
  message: SolverMessage;
  args: NoteArg[];
}

export interface External {
  port: PortRef;
  /** Units/s. */
  ratePerSecond: number;
}

/** The anchors of the open gates: what a stored choice is. Sorted by `comparePortRef`. */
export interface ChoiceKey {
  gateAnchors: PortRef[];
}

export interface Shortfall {
  drawer: Id;
  rule: DrawerRule;
  target: number;
  reachable: number;
  limitingNodes: Id[];
  limitingDrawers: Id[];
  limitingGroups: number;
}

export interface DrawerReadout {
  /** Every drawer's total in units/s at the point. */
  rates: Record<Id, number>;
  /** Drawers whose rule the point does not keep. */
  unmet: Id[];
  shortfalls: Shortfall[];
  /**
   * Per buffer, each port linked to it and what it puts in (a maker's output) or takes out (a user's input), makers
   * first, in link order: what each of its wires carries. Empty for a plan with no buffer.
   */
  ports: Record<Id, External[]>;
  /**
   * Up to plans only (docs/up-to.md, "Buffers"): per BUFFER with rule ANY, what it banks, units/s: what its makers put
   * into it beyond what its takers take (old Build's overflow). Never in the forced flows. Absent when the plan has no
   * Up to pool or no such buffer.
   */
  banked?: Record<Id, number>;
}

/**
 * Why an Up to card runs where it does (docs/up-to.md, "The read-out"; old Build's verdicts):
 * - FULL: at its count; nothing else in the plan would use more of it.
 * - BOTTLENECK: at its count, and the rest of the plan would use more, or a STARVED card is short of what it makes
 *   (`wants`).
 * - STARVED: below its count because its inputs run short, as tight as its outputs or tighter (`port`).
 * - CLOGGED: below its count because its outputs have nowhere to go, strictly tighter than its inputs (`port`).
 * - UNUSED: CLOGGED at zero: nothing takes what it makes (`port`).
 * - LIMITED: below its count for a reason no port explains (another rule of the plan).
 */
export type UpToReason = "FULL" | "BOTTLENECK" | "STARVED" | "CLOGGED" | "UNUSED" | "LIMITED";

/** The read-out of one Up to pool at the committed point. */
export interface UpToReadout {
  /** The pool's first machine: the card (a shared card's section 0). */
  node: Id;
  /** Every machine of the pool, in pool order. */
  machines: Id[];
  /** Up to this many machines (the pool's capacity). */
  capacity: number;
  /** Machines' worth running: the pool's machine time, sum of extent * durTicks / 20. */
  reached: number;
  /** Null when the read-out's work budget ran out before this pool. */
  reason: UpToReason | null;
  /** STARVED, CLOGGED, UNUSED: the port that holds it back (the first in machine, then port order). */
  port?: PortRef;
  /** Other ports that hold it back just as alone. */
  tied?: PortRef[];
  /** BOTTLENECK: how many machines the rest of the plan would use. */
  wants?: number;
  /** STARVED: the Up to cards (their `node`) making the short input that are FULL or BOTTLENECK: where to act. */
  upstream?: Id[];
}

/**
 * A ring of Up to pools that blame each other (docs/up-to.md, "Loops"; old Build's dead loop and clog lock):
 * - DEAD_LOOP: every member is STARVED, and each one's short input is made by the next (a recycling loop that nothing
 *   feeds; the fix is to feed it).
 * - CLOG_LOCK: every member is CLOGGED or UNUSED, and each one's full output is taken by the next (frozen by its own
 *   surplus; the fix is a drawer).
 */
export interface UpToLoop {
  kind: "DEAD_LOOP" | "CLOG_LOCK";
  /** The members' `node`, in pool order. */
  nodes: Id[];
  /** The members' blaming ports (`port`, `tied`) that lie on the ring's edges, member by member. */
  ports: PortRef[];
}

export interface SolutionView {
  /** Up to pools only, by `node` (`compareIds`). Absent when the plan has none. */
  upTo?: UpToReadout[];
  /** The Up to rings, by their first member's `node` (`compareIds`). Absent when there are none. */
  upToLoops?: UpToLoop[];
  /** Crafts/s, every machine (0 for idle). */
  extentsPerSecond: Record<Id, number>;
  /** extent * durTicks / 20, fractional. */
  machineCounts: Record<Id, number>;
  /** Every retained edge (dropped edges are absent). */
  edgeFlowsPerSecond: Record<Id, number>;
  /** FORCED INPUTS: a wired INPUT port where the solve brings material in. */
  gatedSources: External[];
  /** FORCED OUTPUTS: a wired OUTPUT port where the solve sends material out. */
  gatedSinks: External[];
  /** Unwired inputs and the rate they draw. */
  terminalInputs: External[];
  /** Unwired outputs and the rate they make. */
  terminalOutputs: External[];
  /** Unpinned machines the answer leaves at zero. */
  unneeded: Id[];
  openGates: number;
  /** Sum of the reported gated externals (raw units, not crafts). */
  externalQuantity: number;
  totalInternalFlow: number;
  notes: Note[];
  key: ChoiceKey;
  drawers: DrawerReadout;
  spares: Leftover[];
}

export type Rank =
  | "DEFAULT"
  | "EQUALLY_VALID"
  | "BUYS_MORE"
  | "SELLS_MORE"
  | "MOVES_MORE"
  | "MOVES_LESS";

export interface Alternative {
  /** The WHOLE support this option implies (what gets stored when picked). */
  key: ChoiceKey;
  /** The decision it belongs to: the anchor of the gate the incumbent answer opens. */
  replaces: PortRef;
  /** The anchor of the gate it uses instead (== replaces for the current answer). */
  opens: PortRef;
  /** The flows at `opens` only. */
  externals: External[];
  /** Why it is not the default; DEFAULT = the answer on screen. */
  rank: Rank;
}

export interface Alternatives {
  /** The committed support's key. */
  chosen: ChoiceKey | null;
  options: Alternative[];
  /** false if the search was truncated. */
  complete: boolean;
  /** SHOWING_CLOSEST, STOPPED_EARLY. */
  notes: Note[];
}

export interface Bearer {
  /** A gate, named by its anchor port. */
  anchor: PortRef;
  /** What crosses at the gate's ports now (> dust). */
  flows: External[];
  /** What crosses there when it bears the whole leftover. */
  max: number;
  /** Its part of the leftover now, 0..1. */
  share: number;
  /** The solver's own placement. */
  solverPick: boolean;
}

export interface Leftover {
  /** Bearers' keys sorted (UTF-16 order) and joined by "|". A bearer key is `${node}:${i|o}:${port}`. */
  key: string;
  /** A shortfall brought in (true) or a surplus sent out (false). */
  importing: boolean;
  /** In the alternatives list order (the DEFAULT/current row first). */
  bearers: Bearer[];
  /** A stored split is in force. */
  custom: boolean;
}

export type Answer =
  | { kind: "solved"; solution: SolutionView; alternatives: Alternatives }
  | { kind: "failed"; failure: Note; notes: Note[]; drawers: DrawerReadout };

// ---------------------------------------------------------------------------
// What the board reads: `ThroughputResult.plan`
// ---------------------------------------------------------------------------

/**
 * A port named by row, stable across solves:
 * `nodeId|i or o|canonicalHandle`, where `nodeId` is the SOLVE node id (a
 * shared section is `card#rN`) and the handle is the canonical, section-free
 * handle id of the row (`output:item:foo`). See `port-key.ts`.
 */
export type PortKey = string;

export type PlanSide = "in" | "out";

/** A planner-facing note: the solver's note, ids already website ids. */
export type PlanNote = Note;

/** Material the solve brings in or sends out at a wired port that has no drawer. */
export interface PlanForced {
  nodeId: Id;
  portKey: PortKey;
  side: PlanSide;
  /** `kind:id` of the port's row. */
  resourceKey: string;
  perSecond: number;
  /**
   * The decision (see `PlanLeftover.decision`) this open gate belongs to, when the solver listed one: the card's and
   * the rail's way from a forced row to its alternative places. Absent when the gate has no listed alternatives.
   */
  decision?: PortKey;
}

/** One place a leftover can be borne at: an open gate named by a port of it. */
export interface PlanBearer {
  portKey: PortKey;
  /** What crosses at this place when it bears the whole leftover. */
  maxPerSecond: number;
  /** 0..1 */
  share: number;
  solverPick: boolean;
  /** What crosses at the gate's ports now. */
  flows: Array<{ portKey: PortKey; perSecond: number }>;
  /** The solve node and side of `portKey` (the place's card and whether it sits on an input or an output). */
  nodeId?: Id;
  side?: PlanSide;
  /** `kind:id` of the place's resource. */
  resourceKey?: string;
  /** Why it is not the default (`DEFAULT` for the solver's own pick). */
  rank?: Rank;
  /** What crosses at each of the gate's ports when this place bears the whole leftover. */
  whole?: Array<{ portKey: PortKey; side: PlanSide; perSecond: number }>;
  /**
   * The whole support picking this place implies, as the open gates' anchors (the engine's `ChoiceKey`): what a stored
   * choice of it would be. `spareShares` is how it is stored (100% on this place), not this.
   */
  support?: PortKey[];
}

export interface PlanLeftover {
  /**
   * Stable key (`spareShares` is keyed on it): the bearers' PortKeys sorted
   * and joined by U+001F (`makeLeftoverKey` in `port-key.ts`). Never `|`:
   * a PortKey holds it.
   */
  key: string;
  importing: boolean;
  custom: boolean;
  bearers: PlanBearer[];
  /**
   * The decision this leftover is: the anchor of the open gate the solver's own answer opens (= the solver-pick
   * bearer's `portKey`). `PlanForced.decision` points here.
   */
  decision?: PortKey;
  /** `kind:id` of the leftover's resource (every place of it carries this one). */
  resourceKey?: string;
  /** Each place's part now, by `portKey` (sums to 1): the stored split when `custom`, else the default. */
  split?: Record<PortKey, number>;
  /** The solver's own split: 1 on the solver-pick place, 0 elsewhere ("Auto" puts it back). */
  defaultSplit?: Record<PortKey, number>;
}

/** An unwired port: a free terminal that imports or exports at its own rate. */
export interface PlanTerminal {
  nodeId: Id;
  portKey: PortKey;
  side: PlanSide;
  perSecond: number;
}

/** An Up to card's read-out as the board shows it (`UpToReadout` in the website's words). */
export interface PlanUpTo {
  /** Up to this many machines. */
  capacity: number;
  /** Machines' worth running. */
  reached: number;
  reason: UpToReason | null;
  /** STARVED, CLOGGED, UNUSED: the row that holds it back. */
  portKey?: PortKey;
  /** `kind:id` of that row's resource. */
  resourceKey?: string;
  /** Other rows that hold it back just as alone. */
  tied?: PortKey[];
  /** BOTTLENECK: how many machines the rest of the plan would use. */
  wants?: number;
  /** STARVED: card ids upstream on the short input that are full: where to act. */
  upstream?: Id[];
}

/** An Up to ring as the board shows it (`UpToLoop` in the website's words). */
export interface PlanUpToLoop {
  kind: "DEAD_LOOP" | "CLOG_LOCK";
  /** The members' card ids, once each, in the ring's member order. */
  cards: Id[];
  /** The rows on the ring that hold its members back (the members' blaming ports). */
  portKeys: PortKey[];
  /** `kind:id` of those rows' resources, once each, in row order. */
  resourceKeys: string[];
}

/** A drawer whose rule the answer cannot keep, and what holds it back, in card ids. */
export interface PlanShortfall {
  drawerId: Id;
  rule: DrawerRule;
  target: number;
  reachable: number;
  /** Cards whose pin (an exact count, a rate, or an Up to count) holds it back. */
  limitingCards: Id[];
  /** Other drawers whose rule holds it back. */
  limitingDrawers: Id[];
}

export interface PlanSolveExtras {
  /** Every Up to card, by card id (a shared card's whole pool under the card's id). Absent when none. */
  upTo?: Record<Id, PlanUpTo>;
  /** The Up to rings (dead loops and clog locks), in the engine's order. Absent when none. */
  loops?: PlanUpToLoop[];
  /** Drawers the answer falls short of, with what holds each back. Absent when none. */
  shortfalls?: PlanShortfall[];
  forced: PlanForced[];
  leftovers: PlanLeftover[];
  /** Unpinned machines the answer leaves at zero (nothing pinned feeds or needs them). */
  unneeded: Id[];
  /** Recipes AND drawers in a part of the plan that nothing sets ("(set count)" / "Set rate"). */
  unanchored: Id[];
  terminals: PlanTerminal[];
  notes: PlanNote[];
  openGates: number;
  /** Set when the solve failed (NO_PIN included: "nothing sets the plan's size"). */
  failure?: PlanNote;
  /** Drawers whose rule the answer does not keep. */
  unmetDrawers?: Id[];
  /** The open gates the answer uses, as the anchors a stored choice names (engine `ChoiceKey`, as PortKeys). */
  chosen?: PortKey[];
  /** false when the alternatives search was cut short (the rail says the list may be partial). */
  alternativesComplete?: boolean;
  /** The alternatives search's and the stored choice's own notes (SHOWING_CLOSEST, STOPPED_EARLY, CHOICE_*), already in `notes`. */
  choiceNotes?: PlanNote[];
}
