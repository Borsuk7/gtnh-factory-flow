// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { nextFasterAmps, MAX_AMPS, type PowerRun } from "./power-facts";
import { isPinned, steppedOption, toggledPins, type SettingControl } from "./settings-model";
import { rememberSetting } from "@/lib/model/setting-memory";
import { countRowsTip, footTip, ruleTip, stripTip } from "./card-tips";
import type { CleanCardView, CleanChipView, CleanFootView } from "../clean-model";

const run = (duration: number, parallels: number, amps: number): PowerRun => ({
  duration,
  parallels,
  eut: amps * 30,
  runsPerSecond: (parallels * 20) / duration,
});

it("finds the next amp count that runs faster, and none past the one-tick floor", () => {
  // Overclocks every 4 amps: 120 ticks at 1A, 60 at 4A, 30 at 16A, floor 1 tick.
  const at = (amps: number) =>
    run(Math.max(1, 120 / 2 ** Math.floor(Math.log(Math.max(1, amps)) / Math.log(4))), 1, amps);
  expect(nextFasterAmps(at, 1)?.amps).toBe(4);
  expect(nextFasterAmps(at, 4)?.amps).toBe(16);
  expect(nextFasterAmps(() => run(1, 1, 1), 1)).toBeUndefined();
  expect(MAX_AMPS).toBe(16_777_216);
});

const control = (
  id: string,
  pinDefault: boolean,
  keys = ["a", "b", "c"],
  current = "a",
): SettingControl => ({
  id,
  group: "Machine",
  label: id,
  value: current,
  warn: false,
  options: keys.map((key) => ({ key, label: key })),
  currentKey: current,
  pinDefault,
});

it("pins default to the coil, then follow the plan's own list per machine", () => {
  const coil = control("heatingCoil", true);
  const other = control("x", false);
  expect(isPinned({}, "ebf", coil)).toBe(true);
  expect(isPinned({}, "ebf", other)).toBe(false);
  expect(toggledPins({}, "ebf", [coil, other], "x")).toEqual(["heatingCoil", "x"]);
  expect(
    toggledPins(
      { settingPins: { ebf: ["heatingCoil", "x"] } },
      "ebf",
      [coil, other],
      "heatingCoil",
    ),
  ).toEqual(["x"]);
  expect(isPinned({ settingPins: { ebf: [] } }, "ebf", coil)).toBe(false);
  expect(isPinned({ settingPins: { ebf: [] } }, "other", coil)).toBe(true);
});

it("steps through valid options and wraps", () => {
  expect(steppedOption(control("x", false, ["a", "b", "c"], "c"), 1)?.key).toBe("a");
  expect(steppedOption(control("x", false, ["a", "b", "c"], "a"), -1)?.key).toBe("c");
  expect(steppedOption(control("x", false, ["a"]), 1)).toBeUndefined();
});

beforeEach(() => window.localStorage.clear());

it("remembers a machine's setting in the browser, never the parallels", () => {
  rememberSetting("ebf", "heatingCoil", "nichrome");
  rememberSetting("ebf", "machineParallel", "9");
  const stored = JSON.parse(window.localStorage.getItem("gtnh-factory-flow.setting-memory.v1")!);
  expect(stored).toEqual({ "ebf|heatingCoil": "nichrome" });
});

const view = (count: Partial<CleanCardView["count"]>): CleanCardView =>
  ({
    nodeId: "n",
    name: "M",
    count: {
      text: "×0.001",
      value: 0.001,
      pinned: false,
      rule: "any",
      ruleWord: "",
      ruleFixed: false,
      setText: "",
      note: "",
      prompt: false,
      zero: false,
      title: "",
      ...count,
    },
  }) as CleanCardView;

it("count tip carries the mod's rows, and what runs against what is set", () => {
  const tip = countRowsTip(view({}), false);
  expect(tip.title).toBe("Required machines");
  expect(tip.rows?.map((r) => r.label)).toEqual([
    "Calculated",
    "Whole machines",
    "Average utilization",
  ]);
  expect(tip.actions?.map((a) => a.label)).toEqual(["Set a count", "Up to what runs"]);
  const upTo = countRowsTip(
    view({
      pinned: true,
      rule: "upTo",
      ruleWord: "up to",
      set: 24,
      setText: "24",
      text: "×18",
      value: 18,
      title: "As many as it can.",
    }),
    false,
  );
  expect(upTo.title).toBe("Up to 24");
  expect(upTo.rows).toEqual([
    { label: "Running", value: "×18" },
    { label: "Up to", value: "×24" },
    { label: "Usage", value: "75%" },
  ]);
  expect(upTo.actions?.map((a) => a.label)).toEqual([
    "Type a count",
    "+1 / -1",
    "Let the plan decide",
  ]);
  const exact = countRowsTip(
    view({
      pinned: true,
      rule: "exact",
      ruleWord: "exactly",
      set: 3,
      setText: "3",
      text: "×3",
      value: 3,
    }),
    false,
  );
  expect(exact.title).toBe("Exactly 3");
  expect(exact.rows?.map((r) => r.label)).toEqual(["Running", "Exactly"]);
});

it("rule tip: what the rule does, and no menu on a custom rate card", () => {
  expect(ruleTip(view({ pinned: true, rule: "upTo" })).actions?.map((a) => a.label)).toEqual([
    "Any, Up to, Exactly",
  ]);
  expect(ruleTip(view({ pinned: true, rule: "exact", ruleFixed: true })).actions).toEqual([]);
});

it("bar tip: usage, the reason in full and where to act", () => {
  const facts = (f: Partial<CleanFootView["facts"]>): CleanFootView =>
    ({
      facts: {
        reason: "FULL",
        rule: "upTo",
        running: 24,
        capacity: 24,
        tied: [],
        upstream: [],
        forced: [],
        ...f,
      },
    }) as CleanFootView;
  const neck = footTip("n", facts({ reason: "BOTTLENECK", wants: 31 }));
  expect(neck.title).toBe("All 24 running");
  expect(neck.rows).toEqual([
    { label: "Usage", value: "100%" },
    { label: "Wants", value: "×31", tone: "red" },
  ]);
  expect(neck.notes?.[0]?.text).toBe("7 more here would let the line run faster.");
  const starved = footTip(
    "n",
    facts({ reason: "STARVED", running: 18.2, resource: "Oxygen", upstream: ["Electrolyzer"] }),
  );
  expect(starved.title).toBe("18.2 of 24 running");
  expect(starved.rows?.map((r) => `${r.label}: ${r.value}`)).toEqual([
    "Usage: 75.83%",
    "Short of: Oxygen",
    "Full upstream: Electrolyzer",
  ]);
  const forced = footTip(
    "n",
    facts({ reason: "FORCED", rule: "exact", forced: ["720 L/s Oxygen"] }),
  );
  expect(forced.title).toBe("Exactly 24 running");
  expect(forced.rows).toEqual([{ label: "Forced in", value: "720 L/s Oxygen", tone: "warn" }]);
  expect(footTip("n", facts({ reason: "UNUSED", running: 0 })).title).toBe("None running");
  const dead = footTip(
    "n",
    facts({ reason: "STARVED", loop: "dead", running: 0, resource: "Oxygen" }),
  );
  expect(dead.rows?.map((r) => `${r.label}: ${r.value}`)).toEqual([
    "Usage: 0%",
    "Short of: Oxygen",
  ]);
  expect(dead.notes?.[0]?.text).toBe(
    "This loop starves itself to a stop. Bring this input in from outside.",
  );
  const clog = footTip(
    "n",
    facts({ reason: "UNUSED", loop: "clog", running: 0, resource: "Hydrogen" }),
  );
  expect(clog.rows?.map((r) => `${r.label}: ${r.value}`)).toEqual([
    "Usage: 0%",
    "Backs up: Hydrogen",
  ]);
  expect(clog.notes?.[0]?.text).toBe(
    "This loop clogs itself to a stop. A drawer for this output frees it.",
  );
});

it("strip chip tip: Set to, coil need, pinned note, gestures", () => {
  const chip = {
    id: "heatingCoil",
    label: "Heating Coil",
    value: "Kanthal",
    title: "",
    x: 0,
    y: 0,
    width: 0,
  } as CleanChipView;
  const tip = stripTip("n", chip, control("heatingCoil", true), 2140);
  expect(tip.rows).toEqual([
    { label: "Set to", value: "Kanthal" },
    { label: "Recipe needs", value: "2140 K" },
  ]);
  expect(tip.notes?.at(-1)?.text).toBe("Pinned to the card: unpin it in the settings.");
  expect(tip.actions?.map((a) => a.label)).toEqual(["Choose", "Step back", "Step"]);
});
