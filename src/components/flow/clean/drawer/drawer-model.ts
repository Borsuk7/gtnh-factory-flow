import type { FactoryStorage, StorageThroughputResult } from "@/lib/model/types";
import { formatCompact, formatPowerValue } from "@/lib/model";
import type { StorageRole } from "@/lib/model/storage-role";
import { storageTargetMode, type TargetMode } from "@/lib/model/storage-target";
import { rateMultiplierForKind, rateSuffixForKind } from "@/lib/model/rate-unit";
import { RULE_MARK, RULE_NAME, trimFlow } from "../../rate-rule";
import type { DrawerKind } from "../tokens";
import { mcTextWidth, measureRowFigure, measureRowName } from "../text-measure";
import type { TipSpec } from "../interaction/tip-spec";

/**
 * The clean drawer as plain data: every string final, nothing measured from the DOM.
 * `CleanDrawer.tsx` only draws it. The kinds are the mod's (`Drawer.Kind`): a source, a product (a byproduct is a
 * product with no rule), trash, and a buffer (fed and drawn from: the one drawer inside the plan,
 * `docs/buffer-drawers.md`).
 */

/** The menu's last row for a product, and for trash: the mod's words (`DrawerCard.TO_TRASH`, `TO_PRODUCT`). */
export const TO_TRASH = "Void it (trash)";
export const TO_PRODUCT = "Keep it (product)";

/** The words column of the drawer: 76 px at the row's 14 px figure and 9 px name. */
const WORDS = 76;

/** The name's own box (drawer.css .cd-name), which cuts what runs past it: a longer name is faded at its edge. */
const NAME_BOX = 71;

/** The words beside a spill's Forced out tile (drawer.css .cd[data-spill] .cd-num and .cd-name). */
const SPILL_WORDS = 41;

/**
 * Whether the clean drawer draws this one: every drawer. A power drawer is the same source or product drawer with
 * EU in it (its picture the bolt in its amber box); a buffer is its own kind. The classic drawer is no longer
 * reachable from the board.
 */
export function supportsCleanDrawer(
  _storage: Pick<FactoryStorage, "kind">,
  _role: StorageRole,
): boolean {
  void _storage;
  void _role;
  return true;
}

/** The mod's kind: trash is steel, a source blue, everything that leaves the plan orange, a buffer teal. */
export function drawerKindFor(
  role: StorageRole,
  storage: Pick<FactoryStorage, "targetPerSecond">,
): DrawerKind {
  if (role === "source") return "source";
  if (role === "trash") return "trash";
  if (role === "buffer") return "buffer";
  // An unwired drawer reads as the end it was made as (a negative goal is an input).
  if (role === "idle" && (storage.targetPerSecond ?? 0) < 0) return "source";
  return "product";
}

/** A rate in the board's unit as the drawer's own figure: `trimFlow` below a thousand, `k` and `M` above. */
export function formatRateField(perSecond: number, kind: string): string {
  const scaled = Math.abs(perSecond * rateMultiplierForKind(kind));
  if (kind === "power") return formatPowerValue(scaled);
  if (scaled >= 1_000_000) return `${trimFlow(scaled / 1_000_000)}M`;
  if (scaled >= 1_000) return `${trimFlow(scaled / 1_000)}k`;
  return scaled >= 1 ? trimFlow(scaled) : formatCompact(scaled);
}

/** What the plan moves through the drawer, as a figure and its unit (no sign). */
export function formatRateParts(perSecond: number, kind: string): { number: string; unit: string } {
  const scaled = Math.abs(perSecond * rateMultiplierForKind(kind));
  const unit = rateSuffixForKind(kind).trim();
  if (!Number.isFinite(scaled) || scaled < 0.000005) return { number: "0", unit };
  return { number: formatRateField(perSecond, kind), unit };
}

export type ProgressTone = "ok" | "bad" | "calm";

export interface CleanDrawerView {
  id: string;
  kind: DrawerKind;
  /** The resource's name. */
  label: string;
  number: string;
  perSecond: number;
  unit: string;
  zero: boolean;
  numberSmall: boolean;
  nameSmall: boolean;
  nameClipped: boolean;
  /** A source or a product has a rule key and a rate box; trash a key and "Voided". */
  hasRule: boolean;
  /** The rule as shown: Any when no number applies. */
  rule: TargetMode;
  ruleMark: string;
  /** The rate box: the target as a figure, undefined on Any. */
  target?: { number: string; unit: string };
  /** The box's words when there is no target: Set, Set rate (pulsing) or Voided. */
  boxText: string;
  /** Nothing sets this part of the plan: the box asks for a rate. */
  prompt: boolean;
  /** The plan cannot reach the target. */
  unmet: boolean;
  /** What the plan reaches, as a figure with its unit (only when unmet). */
  reaches?: string;
  /** The share of the target in use, 0..1, when there is a target. */
  progress?: number;
  tone: ProgressTone;
  linked: boolean;
  /** The glance pill: a sign and a short figure. */
  glanceRate: string;
  /**
   * A buffer whose makers make more than its users take: the extra, forced out at the makers, totalled on a small
   * Forced out tile left of the drawer's own figure (the drawer grows a cell wider by it).
   */
  spill?: { number: string; unit: string; tip: TipSpec };
  tips: { bar: TipSpec; del: TipSpec; rule: TipSpec; rate: TipSpec; body: TipSpec };
  /** The key that makes an input drawer an output one or the reverse (its wires come off); absent on a buffer. */
  flip?: TipSpec;
}

export interface DrawerViewInput {
  storage: FactoryStorage;
  role: StorageRole;
  label: string;
  result: StorageThroughputResult | undefined;
  /** The plan's `unanchored` includes this drawer: nothing sets its part of the plan. */
  unanchored: boolean;
  /** The plan's `unmetDrawers` includes it. */
  unmet: boolean;
  linked: boolean;
  /** What the makers of a buffer force out beyond what its users take, per second (the plan's `spills`, summed). */
  spill?: number;
}

const KIND_NAME: Record<DrawerKind, string> = {
  source: "Source",
  product: "Product",
  trash: "Trash",
  buffer: "Buffer",
};

/** What a buffer passes: what its makers put in, which is what its users take out. */
export function bufferThroughput(result: Pick<StorageThroughputResult, "producedPerSecond"> | undefined): number {
  return Math.abs(result?.producedPerSecond ?? 0);
}

function ruleMeaning(kind: DrawerKind, rule: TargetMode): string {
  const flow = kind === "source" ? "draws from it" : "puts in it";
  switch (rule) {
    case "ignore":
      return `No target: the plan ${flow} whatever it needs.`;
    case "at-least":
      return `The plan ${flow} at least the rate.`;
    case "exact":
      return `The plan ${flow} exactly the rate.`;
    case "at-most":
      return `The plan ${flow} no more than the rate.`;
  }
}

export function buildDrawerView(input: DrawerViewInput): CleanDrawerView {
  const { storage, role, label, result, unanchored, unmet, linked, spill } = input;
  const kind = drawerKindFor(role, storage);
  const resourceKind = storage.kind;
  // A buffer's net is zero (in equals out): its figure is what passes through.
  const net = kind === "buffer" ? bufferThroughput(result) : Math.abs(result?.netPerSecond ?? 0);
  const { number, unit } = formatRateParts(net, resourceKind);
  const zero = !(net > 0.000005);
  // A buffer has no rule: it passes what its users take. Trash has its key but no rate.
  const hasRule = kind !== "trash" && kind !== "buffer";
  const target = storage.targetPerSecond;
  // A byproduct is a product with no rule: whatever its stored rule, it reads as Any until it is made a product.
  const inert = role === "byproduct" || role === "trash";
  const mode = storageTargetMode(storage, role);
  const hasTarget =
    hasRule &&
    !inert &&
    target !== undefined &&
    mode !== "ignore" &&
    Number.isFinite(target) &&
    (target !== 0 || mode === "exact" || mode === "at-most");
  const rule: TargetMode = hasTarget ? mode : "ignore";
  const targetParts = hasTarget
    ? {
        number: formatRateField(target!, resourceKind),
        unit: rateSuffixForKind(resourceKind).trim(),
      }
    : undefined;
  const unitLabel = rateSuffixForKind(resourceKind).trim();
  const prompt = hasRule && !hasTarget && unanchored;
  const share =
    hasTarget && Math.abs(target!) > 0 ? Math.min(1, net / Math.abs(target!)) : undefined;
  const isUnmet = hasTarget && (unmet || result?.targetUnreachable === true);
  const tone: ProgressTone = isUnmet ? "bad" : rule === "at-most" ? "calm" : "ok";
  const sign = zero || kind === "buffer" ? "" : kind === "source" ? "-" : "+";
  const reaches = isUnmet ? `${formatRateField(net, resourceKind)} ${unitLabel}` : undefined;
  const flowWord = kind === "source" ? "Supplies" : kind === "buffer" ? "Passes" : "Takes";

  // The mod's tips (`DrawerCard.tip`), word for word.
  const ruleTip: TipSpec =
    kind === "trash"
      ? {
          id: `${storage.id}|rule`,
          title: "Trash",
          notes: [
            {
              text: "It voids what comes in: it leaves the plan without being one of its outputs.",
              tone: "muted",
            },
          ],
          actions: [{ input: "left", label: "Keep it instead" }],
        }
      : {
          id: `${storage.id}|rule`,
          title: "Rule",
          sub: RULE_NAME[rule],
          notes: [{ text: ruleMeaning(kind, rule), tone: "muted" }],
          actions: [
            { input: "left", label: "Pick" },
            { input: "wheel", label: "Next" },
            { input: "middle", label: "Clear" },
          ],
        };
  const rateRows: NonNullable<TipSpec["rows"]> = [];
  if (hasTarget) rateRows.push({ label: RULE_NAME[rule], value: `${targetParts!.number} ${unitLabel}` });
  if (isUnmet) rateRows.push({ label: "Reaches", value: reaches!, tone: "red" });
  const rateTip: TipSpec = {
    id: `${storage.id}|rate`,
    title: hasTarget ? "Target rate" : "No rate yet",
    rows: rateRows,
    actions: [
      { input: "left", label: "Type (2.5k, 1/3)" },
      { input: "wheel", label: "+1, Ctrl 10, Shift 100" },
      { input: "middle", label: "Clear" },
    ],
  };
  // A buffer never dumps: what its makers make beyond what its users take is forced out at the makers (their Forced
  // tiles) and only totalled here, on a Forced tile of its own under the row.
  const spilling = kind === "buffer" && spill !== undefined && spill > 0.000005;
  const spillText = spilling ? formatRateField(spill!, resourceKind) : undefined;
  const bodyNotes: NonNullable<TipSpec["notes"]> = [];
  if (kind === "buffer") bodyNotes.push({ text: "Its makers put in what its users take out.", tone: "muted" });
  if (!linked) bodyNotes.push({ text: "Unconnected", tone: "warn" });
  if (isUnmet && hasTarget) {
    bodyNotes.push({
      text: `Reaches only ${reaches} of its ${targetParts!.number} ${unitLabel} target`,
      tone: "red",
    });
  }
  const bodyTip: TipSpec = {
    id: `${storage.id}|body`,
    title: label,
    sub: KIND_NAME[kind],
    rows: [{ label: flowWord, value: `${number} ${unitLabel}` }],
    notes: bodyNotes,
    actions: [
      { input: "drag", label: "Wire to a card" },
      { input: "key", label: "R, U" },
    ],
  };

  return {
    id: storage.id,
    kind,
    label,
    number,
    perSecond: net,
    unit,
    zero,
    numberSmall: measureRowFigure(number, unit) > (spilling ? SPILL_WORDS : WORDS),
    // The mod's rule, as the card's (CardPaint.words).
    nameSmall: mcTextWidth(label) > 71,
    nameClipped: measureRowName(label, mcTextWidth(label) > 71) > (spilling ? SPILL_WORDS : NAME_BOX),
    hasRule,
    rule,
    ruleMark: kind === "trash" ? "×" : RULE_MARK[rule],
    target: targetParts,
    boxText: kind === "trash" ? "Voided" : "Set", // the mod says "Set", pulsing gold while nothing is set
    prompt,
    unmet: isUnmet,
    reaches,
    progress: share,
    tone,
    linked,
    glanceRate: `${sign}${number}`,
    ...(kind === "buffer"
      ? {}
      : {
          flip: {
            id: `${storage.id}|flip`,
            title: kind === "source" ? "Make it an output" : "Make it an input",
            notes: [{ text: "Its wires come off.", tone: "muted" as const }],
            actions: [{ input: "left" as const, label: "Switch" }],
          },
        }),
    ...(spilling
      ? {
          spill: {
            number: spillText!,
            unit,
            tip: {
              id: `${storage.id}|spill`,
              title: "Forced out",
              rows: [{ label: "At its makers", value: `${spillText} ${unitLabel}` }],
              notes: [
                {
                  text: `Its makers make ${spillText} ${unitLabel} more than its users take. They force it out themselves; this adds it up.`,
                  tone: "muted",
                },
              ],
            },
          },
        }
      : {}),
    tips: {
      bar: {
        id: `${storage.id}|bar`,
        title: label,
        sub: KIND_NAME[kind],
        actions: [
          { input: "drag", label: "Move" },
          { input: "left", label: "Select" },
        ],
      },
      del: {
        id: `${storage.id}|del`,
        title: "Delete this drawer",
        actions: [{ input: "left", label: "Delete" }],
      },
      rule: ruleTip,
      rate: rateTip,
      body: bodyTip,
    },
  };
}
