import { formatCompact } from "@/lib/model/resources";
import { getStorageRoles } from "@/lib/model/storage-role";
import type { FactoryProject, ResourceKind, ThroughputResult } from "@/lib/model/types";
import { rateMultiplierForKind, rateSuffixForKind } from "@/lib/model/rate-unit";
import { pinRuleOf } from "@/lib/model/pin-rule";
import { UP_TO_WORD } from "../up-to-reason";
import { loopSentence, loopTag, loopTone, type LoopTone } from "../loops";
import type { Note, NoteArg, PlanNote, PlanShortfall } from "@/lib/solver/plan/types";
import { splitResultNodeId } from "./rail-model";

/**
 * The notices bar's list: the solver's notes in the mod's words
 * (`BoardSession.buildNotices`), most important first. Each is
 * `{ severity, text, focus }` where `focus` are the card and drawer ids
 * "Show me" frames. Pure; the sentences are the catalogue of the UI spec
 * section 11.2, exactly.
 */

export type NoticeSeverity = "error" | "warn" | "info";

export interface BoardNotice {
  /** Stable across solves while the same sentence stands (keys the per-notice "Show me" counter). */
  id: string;
  severity: NoticeSeverity;
  text: string;
  focus: string[];
  /** A notice the player can put away (the plan conversion's): the row shows a Dismiss key. */
  dismiss?: () => void;
  /** An alarm's name ("DEAD LOOP"): a chip before the sentence, blinking on the prompts' clock. */
  tag?: string;
  /** The ring an alarm is about: its row and chip take the ring's tone, as its cards' outlines do. */
  loop?: LoopTone;
}

/** Where a notice goes in the list, lowest first: a failed solve, then alarms, then warnings, then the rest. */
export function noticeRank(notice: Pick<BoardNotice, "severity" | "tag">): number {
  if (notice.severity === "error") return notice.tag ? 1 : 0;
  return notice.severity === "warn" ? 2 : 3;
}

/** Most pressing first; notices of one rank keep their order. */
export function byUrgency<T extends Pick<BoardNotice, "severity" | "tag">>(
  list: readonly T[],
): T[] {
  return [...list].sort((a, b) => noticeRank(a) - noticeRank(b));
}

function isNote(arg: NoteArg | undefined): arg is Note {
  return typeof arg === "object" && arg !== null && !Array.isArray(arg);
}

/** Every note of a kind inside a note's arguments, nested notes and lists included. */
function collect(arg: NoteArg | PlanNote, kind: string, into: Note[]): void {
  if (Array.isArray(arg)) {
    for (const entry of arg) collect(entry, kind, into);
    return;
  }
  if (!isNote(arg)) return;
  if (arg.message === kind) into.push(arg);
  for (const nested of arg.args) collect(nested, kind, into);
}

function contains(note: Note, ...kinds: string[]): boolean {
  return kinds.some((kind) => {
    const found: Note[] = [];
    collect(note, kind, found);
    return found.length > 0;
  });
}

function rate(perSecond: number, kind: ResourceKind): string {
  const value = perSecond * rateMultiplierForKind(kind);
  const suffix = rateSuffixForKind(kind);
  return `${formatCompact(value)}${suffix.startsWith(" ") ? suffix : ` ${suffix}`}`;
}

const text = (arg: NoteArg | undefined): string =>
  typeof arg === "string" || typeof arg === "number" ? String(arg) : "";
const num = (arg: NoteArg | undefined): number => (typeof arg === "number" ? arg : 0);

const RULE_BY_NOTE: Record<string, "at-least" | "exact" | "at-most" | "ignore"> = {
  RULE_AT_LEAST: "at-least",
  RULE_EXACTLY: "exact",
  RULE_AT_MOST: "at-most",
  RULE_ANY: "ignore",
};

export function buildNotices(
  project: FactoryProject,
  result: ThroughputResult | undefined,
): BoardNotice[] {
  const extras = result?.plan;
  if (!extras) return [];
  const out: BoardNotice[] = [];
  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const storages = project.storages ?? [];
  const known = new Set([...nodeIds, ...storages.map((s) => s.id)]);
  const idsIn = (note: Note): string[] => {
    const ids: string[] = [];
    const walk = (arg: NoteArg) => {
      if (Array.isArray(arg)) arg.forEach(walk);
      else if (isNote(arg)) arg.args.forEach(walk);
      else if (typeof arg === "string") {
        const { cardId } = splitResultNodeId(arg);
        if (known.has(cardId)) ids.push(cardId);
      }
    };
    note.args.forEach(walk);
    return [...new Set(ids)];
  };

  // The failure, as what the player can do about it.
  const failure = extras.failure;
  if (failure) {
    if (failure.message === "NO_PIN") {
      if (project.nodes.length > 0) {
        out.push({
          id: "no-pin",
          severity: "info",
          text: "Nothing to calculate yet: set a rate on a drawer, or pin a machine count",
          focus: [],
        });
      }
    } else if (failure.message !== "EMPTY_GRAPH") {
      out.push(failureNotice(failure, idsIn));
    }
  }

  const recipeOf = new Map(project.recipes.map((r) => [r.id, r]));
  const cardName = (id: string): string => {
    const node = project.nodes.find((n) => n.id === id);
    return recipeOf.get(node?.recipeId ?? "")?.machineType ?? "machine";
  };

  // Old Build's rings: a dead loop's cards starve each other, a clog lock's clog each other on a surplus. Alarms: tagged,
  // in the ring's tone, blinking, right under a failed solve. Show me frames the ring's cards.
  for (const loop of extras.loops ?? []) {
    const cards = loop.cards.filter((id) => nodeIds.has(id));
    if (cards.length === 0) continue;
    out.push({
      id: `loop:${loop.kind}:${cards.join(",")}`,
      severity: "error",
      tag: loopTag(loop),
      loop: loopTone(loop),
      text: loopSentence(loop, cards.length),
      focus: cards,
    });
  }

  // The cards and drawers that hold a drawer's rate back, as short sentences.
  const holdersOf = (s: PlanShortfall): string => {
    const parts: string[] = [];
    for (const id of s.limitingCards) {
      const node = project.nodes.find((n) => n.id === id);
      const reason = extras.upTo?.[id]?.reason;
      const name = cardName(id);
      if (node && pinRuleOf(node) === "exact") parts.push(`The ${name} is set exactly.`);
      else if (reason && reason !== "FULL" && reason !== "BOTTLENECK")
        parts.push(`The ${name} is ${UP_TO_WORD[reason].toLowerCase()}.`);
      else parts.push(`The ${name} is full.`);
    }
    for (const id of s.limitingDrawers) {
      const other = storages.find((o) => o.id === id);
      parts.push(
        `The ${other?.displayName ?? other?.resourceId ?? "other"} drawer's rate holds it back.`,
      );
    }
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
  };
  const holdingIds = (s: PlanShortfall): string[] => [...s.limitingCards, ...s.limitingDrawers];

  // A drawer whose rule the answer does not keep: what it asks and what the plan does instead.
  const roles = getStorageRoles(project);
  const unmet = (extras.unmetDrawers ?? [])
    .map((id) => storages.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  for (const note of extras.notes) {
    if (note.message !== "DRAWER_UNMET") continue;
    const label = text(note.args[0]);
    const ruleNote = note.args[1];
    const rule = isNote(ruleNote) ? RULE_BY_NOTE[ruleNote.message] : undefined;
    const asked = num(note.args[2]);
    const reached = num(note.args[3]);
    const storage =
      unmet.find((s) => (s.displayName ?? s.resourceId) === label) ??
      unmet.find((s) => s.resourceId === label);
    const supply = storage ? roles.get(storage.id) === "source" : false;
    const kind: ResourceKind = storage?.kind ?? "item";
    const who = `The ${label} ${supply ? "supply" : "drawer"}`;
    const target = rate(asked, kind);
    const reach = rate(reached, kind);
    const shortfall = storage
      ? extras.shortfalls?.find((s) => s.drawerId === storage.id && s.reachable < s.target)
      : undefined;
    const holders = shortfall ? holdersOf(shortfall) : "";
    const sentence = shortfall
      ? `The ${label} ${supply ? "supply" : "drawer"} gets ${reach} of ${target}.${holders}`
      : reached > asked
        ? `${who} allows at most ${target}, but the plan ${supply ? "needs" : "makes"} ${reach}`
        : `${who} ${supply ? "should give" : "wants"} ${rule === "exact" ? "exactly " : ""}${target}, but the plan can only ${supply ? "use" : "make"} ${reach}`;
    out.push({
      id: `unmet:${storage?.id ?? label}`,
      severity: "warn",
      text: sentence,
      focus: storage ? [storage.id, ...(shortfall ? holdingIds(shortfall) : [])] : [],
    });
  }

  for (const note of extras.notes) {
    if (note.message === "OVERSHOOTS_TARGET") {
      const kind: ResourceKind = "item";
      const machine = text(note.args[0]);
      out.push({
        id: `overshoot:${text(note.args[4])}:${text(note.args[1])}`,
        severity: "warn",
        text: `The ${machine} makes ${rate(num(note.args[2]), kind)} of ${text(note.args[1])}, more than its ${rate(num(note.args[3]), kind)} target, because another of its outputs needs more`,
        focus: idsIn(note),
      });
    } else if (note.message === "DRAWER_NOT_CONNECTED") {
      out.push({
        id: `unwired:${text(note.args[1])}`,
        severity: "warn",
        text: `The ${text(note.args[0])} drawer has a rate, but nothing is wired to it`,
        focus: idsIn(note),
      });
    } else if (note.message === "DRAWER_WIRED_IGNORED") {
      out.push({
        id: `ignored:${text(note.args[1])}`,
        severity: "warn",
        text: `The ${text(note.args[0])} drawer's rate does nothing: the ports it's on are wired`,
        focus: idsIn(note),
      });
    } else if (
      note.message === "CHOICE_NO_LONGER_FITS" ||
      note.message === "CHOICE_NEEDS_MORE_GATES"
    ) {
      out.push({
        id: "choice",
        severity: "warn",
        text: "Your saved choice no longer fits this plan, so the planner's own answer is shown",
        focus: [],
      });
    }
  }
  return dedupe(byUrgency(out));
}

function dedupe(list: BoardNotice[]): BoardNotice[] {
  const seen = new Set<string>();
  return list.filter((n) => (seen.has(n.text) ? false : (seen.add(n.text), true)));
}

/** A solve that found no answer, as what the player can do about it. */
function failureNotice(note: Note, idsIn: (note: Note) => string[]): BoardNotice {
  const clashing: Note[] = [];
  collect(note, "PIN_DROPPED", clashing);
  if (clashing.length > 0) {
    const names: string[] = [];
    const ids: string[] = [];
    for (const pin of clashing) {
      const name = text(pin.args[0]);
      if (name && !names.includes(name)) names.push(name);
      ids.push(...idsIn(pin));
    }
    return {
      id: "pin-conflict",
      severity: "error",
      text: `The pinned counts on ${names.join(" and ")} can't all be met at once: unpin one`,
      focus: [...new Set(ids)],
    };
  }
  if (contains(note, "MACHINES_CANNOT_RUN")) {
    return {
      id: "cannot-run",
      severity: "error",
      text: "Some machines can't run with these rates and pinned counts",
      focus: [],
    };
  }
  if (
    contains(note, "SOLVER_UNSATISFIABLE", "SOLVER_NO_SOLUTION", "SOLVER_BUDGET", "STAGE_FAILED")
  ) {
    return {
      id: "no-way",
      severity: "error",
      text: "There's no way to meet all these rates and pinned counts: change a rate or unpin a count",
      focus: [],
    };
  }
  return {
    id: "failed",
    severity: "error",
    text: "The planner couldn't solve this plan (the details are in the log)",
    focus: [],
  };
}
