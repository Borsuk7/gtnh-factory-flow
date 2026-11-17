// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { FactoryNode, Recipe, ResourceKind } from "@/lib/model/types";
import type { RailPort } from "../../node-verdict";
import type { CleanCardContext, CleanPortView } from "../clean-model";
import { buildCountView, buildFootView, layoutStrip } from "../clean-model";
import { SpecialCard } from "./SpecialCard";
import type { SpecialModel } from "./use-special";
import type { SpecialSection, SpecialView } from "./special-model";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false }));

beforeAll(() => {
  // jsdom has no ResizeObserver; React Flow's provider asks for one.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

/**
 * The plain card's reference costs at most 70 elements. A shared machine card adds, for each recipe after the first,
 * its rule (7 elements) and its ports: 50 in all. A generator and a holder stay under the plain budget.
 */
const PER_EXTRA_RECIPE = 50;
const PLAIN_BUDGET = 70;

function port(
  side: "input" | "output",
  n: number,
  nodeId = "n1",
  kind: ResourceKind = "item",
  prefix = "",
): CleanPortView {
  const resource = {
    kind,
    id: `mock:${prefix}${side}${n}`,
    amount: 1,
    displayName: `Resource ${prefix}${side} ${n}`,
    iconPath: "/mock.png",
  };
  const rail = {
    side,
    key: `${prefix}${side}:${n}`,
    kind,
    resourceId: resource.id,
    displayName: resource.displayName,
    handleId: `${prefix}${side}:${kind}:${resource.id}`,
    resource,
    connected: n !== 2,
    currentPerSecond: 1.5,
  } as unknown as RailPort;
  return {
    key: rail.key,
    nodeId,
    handleId: rail.handleId,
    side,
    port: rail,
    number: "900",
    perSecond: rail.currentPerSecond,
    unit: "/hr",
    name: resource.displayName,
    title: resource.displayName,
    zero: false,
    gold: false,
    numberSmall: false,
    nameSmall: false,
    nameClipped: false,
    wired: rail.connected,
    choice: false,
    resourceKey: `${kind}:${resource.id}`,
    forced: undefined,
  };
}

function section(index: number, ins: number, outs: number, shared: boolean): SpecialSection {
  const prefix = index > 0 ? `r${index}:` : "";
  return {
    section: index,
    inputs: Array.from({ length: ins }, (_, i) => port("input", i + 1, "n1", "item", prefix)),
    outputs: Array.from({ length: outs }, (_, i) => port("output", i + 1, "n1", "item", prefix)),
    rule: shared
      ? {
          section: index,
          pct: "50%",
          word: "×1.5",
          unused: false,
          canUp: index > 0,
          canDown: index < 1,
        }
      : undefined,
  };
}

const countOf = (
  rule: "any" | "upTo" | "exact",
  pin: number | undefined,
  value: number,
  opts = {},
) =>
  buildCountView(
    { rule, pin, pinned: rule !== "any", value, needed: value, unset: false, upTo: undefined },
    opts,
  );
const COUNT = countOf("any", undefined, 1.5);

function baseView(): SpecialView {
  return {
    kind: "shared",
    nodeId: "n1",
    name: "Large Chemical Reactor",
    nameSize: 12,
    nameTone: "ink",
    hasPicker: true,
    tier: { label: "IV", fixed: false, title: "" },
    amps: { label: "1A", value: 1, editable: true },
    sections: [section(0, 3, 2, true), section(1, 2, 2, true)],
    power: { number: "7.68k", unit: "EU/t", name: "Power", stalled: false, title: "" },
    art: "/power-art/mock.png",
    count: COUNT,
    chips: [],
    stripHeight: 0,
    warnings: [],
    selected: false,
    cannotRun: false,
    unset: false,
    handleIds: [],
  };
}

const context = {
  machineHandlers: [],
  selectedMachineHandler: { id: "lcr", label: "Large Chemical Reactor" },
  settings: [],
  readings: [],
  sheet: { kind: "machine" },
  handleIds: [],
} as unknown as SpecialModel["context"] & CleanCardContext;

const noop = () => undefined;
const actions: SpecialModel["actions"] = {
  stepTier: noop,
  setAmps: noop,
  cycleMachine: noop,
  switchMachine: noop,
  setCount: noop,
  stepCount: noop,
  setRule: vi.fn(),
  stepSetting: noop,
  stepChip: noop,
  moveSection: vi.fn(),
  removeSection: vi.fn(),
};
const recipe = { id: "r" } as unknown as Recipe;
const node = { id: "n1" } as unknown as FactoryNode;

function renderCard(view: SpecialView, ctx = context) {
  return render(
    <ReactFlowProvider>
      <SpecialCard model={{ view, actions, context: ctx }} recipe={recipe} node={node} />
    </ReactFlowProvider>,
  );
}

it("costs about a recipe's worth of elements for each recipe on a shared machine", () => {
  const { container } = renderCard(baseView());
  const count = container.querySelectorAll("*").length;
  console.info(`[special card] shared machine, two recipes, DOM elements: ${count}`);
  expect(count).toBeLessThanOrEqual(PLAIN_BUDGET + PER_EXTRA_RECIPE);
});

it("draws a rule over every recipe with its share, and keys that move and remove it", () => {
  const { container } = renderCard(baseView());
  const rules = container.querySelectorAll(".sp-rule");
  expect(rules.length).toBe(2);
  expect(rules[0]!.querySelector(".sp-pct")!.textContent).toBe("50%");
  expect(rules[0]!.querySelectorAll(".sp-rk").length).toBe(3);
  // The first recipe cannot go up, the last cannot go down.
  expect(rules[0]!.querySelector('.sp-rk[data-kind="up"]')!.hasAttribute("data-disabled")).toBe(
    true,
  );
  expect(rules[1]!.querySelector('.sp-rk[data-kind="down"]')!.hasAttribute("data-disabled")).toBe(
    true,
  );
  expect(rules[0]!.querySelector('.sp-rk[data-kind="down"]')!.hasAttribute("data-disabled")).toBe(
    false,
  );
});

it("puts each recipe's rails on its own grid row, the picture and the power row in the card", () => {
  const { container } = renderCard(baseView());
  const rails = [...container.querySelectorAll<HTMLElement>(".cc-rail[data-section]")];
  const rows = rails.map((rail) => rail.style.gridRow);
  // rule 2, rails 3; rule 4, rails 5
  expect(rows).toEqual(["3", "3", "5", "5"]);
  expect(container.querySelectorAll(".cc-row[data-power]").length).toBe(1);
  expect(container.querySelectorAll(".cc-pic").length).toBe(1);
  // Section 1's ports keep the section prefix on their handles, so wires land on the right recipe.
  const handle = container
    .querySelector('.cc-rail[data-section="1"] .cc-row[data-port]')!
    .getAttribute("data-resource-handle-id");
  expect(handle!.startsWith("r1:")).toBe(true);
});

it("says what a recipe with nothing on one side has", () => {
  const view = baseView();
  view.sections = [section(0, 2, 0, true), section(1, 0, 1, true)];
  const { container } = renderCard(view);
  const none = [...container.querySelectorAll(".sp-none")].map((el) => el.textContent);
  expect(none).toEqual(["No output", "No input"]);
});

it("keeps every control a div, so the button font rule cannot reach it", () => {
  const { container } = renderCard(baseView());
  expect(container.querySelectorAll("button, input, select, textarea").length).toBe(0);
});

it("draws a generator with an amber name, one EU port out and its warnings under the strip", () => {
  const strip = layoutStrip([{ id: "fuel", label: "Fuel", value: "Diesel", title: "" }]);
  const eu = port("output", 1, "n1", "power");
  const view: SpecialView = {
    ...baseView(),
    kind: "power",
    name: "Large Gas Turbine",
    nameTone: "power",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [port("input", 1)], outputs: [eu] }],
    power: undefined,
    chips: strip.chips,
    stripHeight: strip.height,
    warnings: ["Rotor too weak for this fuel."],
  };
  const { container } = renderCard(view, {
    ...context,
    sheet: { kind: "rows", rows: [] },
  } as typeof context);
  const count = container.querySelectorAll("*").length;
  console.info(`[special card] generator DOM elements: ${count}`);
  expect(count).toBeLessThanOrEqual(PLAIN_BUDGET);
  expect(container.querySelector(".cc-name")!.getAttribute("data-tone")).toBe("power");
  expect(container.querySelectorAll(".cc-bolt").length).toBe(1);
  // EU takes no rate controls.
  expect(container.querySelector('.cc-row[data-side="output"] .cc-prk')).toBeNull();
  expect(container.querySelector(".sp-warns")!.textContent).toBe("Rotor too weak for this fuel.");
  expect(container.querySelectorAll(".cc-sc").length).toBe(1);
});

it("shows an empty holder as two dashed sockets whose handles take any resource", () => {
  const view: SpecialView = {
    ...baseView(),
    kind: "custom-rate",
    name: "Custom Rate",
    nameTone: "holder",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [], outputs: [] }],
    power: undefined,
    sockets: {
      take: "DRAIN ANY",
      give: "SUPPLY ANY",
      takeHandle: "input:item:custom-any",
      giveHandle: "output:item:custom-any",
    },
    glyph: "gauge",
    art: undefined,
  };
  const { container } = renderCard(view);
  expect(container.querySelectorAll(".sp-socket").length).toBe(2);
  expect(container.querySelectorAll(".sp-gauge").length).toBe(1);
  expect(container.querySelectorAll(".cc-rail").length).toBe(0);
  const handles = [...container.querySelectorAll(".sp-socket")].map((el) =>
    el.getAttribute("data-resource-handle-id"),
  );
  expect(handles).toEqual(["input:item:custom-any", "output:item:custom-any"]);
  expect(container.querySelectorAll("*").length).toBeLessThanOrEqual(PLAIN_BUDGET);
});

it("gives a fluid tank no count", () => {
  const view: SpecialView = {
    ...baseView(),
    kind: "tank",
    name: "Fluid Tank",
    nameTone: "holder",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [], outputs: [] }],
    power: undefined,
    count: undefined,
    sockets: { take: "TAKE CELL/FLUID", give: "GIVE CELL/FLUID", takeHandle: "i", giveHandle: "o" },
  };
  const { container } = renderCard(view);
  expect(container.querySelector(".cc-count")).toBeNull();
});

it("shows a farm with no crop as one dashed key to pick one", () => {
  const view: SpecialView = {
    ...baseView(),
    kind: "crop",
    name: "Pick a crop...",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [], outputs: [] }],
    power: undefined,
    count: undefined,
    pick: true,
  };
  const { container } = renderCard(view);
  expect(container.querySelectorAll(".sp-pick").length).toBe(1);
  expect(container.querySelector(".cc-pic")).toBeNull();
  expect(container.querySelectorAll(".cc-rail").length).toBe(0);
});

it("gives a shared machine one count and one bar for the card, under its last row", () => {
  const view = baseView();
  const count = countOf("upTo", 6, 4);
  const inputs = view.sections.flatMap((entry) => entry.inputs);
  const outputs = view.sections.flatMap((entry) => entry.outputs);
  const { container } = renderCard({
    ...view,
    count,
    foot: buildFootView(
      count,
      { capacity: 6, reached: 4, reason: "CLOGGED", resourceKey: outputs.at(-1)!.resourceKey },
      { inputs, outputs },
    ),
  });
  expect(container.querySelectorAll(".cc-count").length).toBe(1);
  expect(container.querySelector(".cc-count")!.getAttribute("data-run")).toBe("×4");
  expect(container.querySelector(".cc-rule")!.textContent).toBe("Up to");
  const foot = container.querySelectorAll<HTMLElement>(".cc-foot");
  expect(foot.length).toBe(1);
  // The second recipe's row names the reason: the bar reads every recipe's rows.
  expect(foot[0]!.textContent).toBe(`${outputs.at(-1)!.name} has nowhere to go`);
  // Rules 2 and 4, rails 3 and 5, the power row 6, the strip 7: the bar is under all of it.
  expect(foot[0]!.style.gridRow).toBe("9");
});

it("keeps a custom rate card Exactly: its rule word opens no menu", () => {
  const view: SpecialView = {
    ...baseView(),
    kind: "custom-rate",
    name: "Custom Rate",
    nameTone: "holder",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [], outputs: [port("output", 1)] }],
    power: undefined,
    glyph: "gauge",
    art: undefined,
    count: countOf("exact", 1, 1, { ruleFixed: true }),
  };
  const { container } = renderCard(view);
  const rule = container.querySelector(".cc-rule")!;
  expect(rule.textContent).toBe("Exactly");
  expect(rule.hasAttribute("data-fixed")).toBe(true);
  expect(rule.getAttribute("role")).toBeNull();
  fireEvent.click(rule);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(container.querySelector(".cc-foot")).toBeNull();
});

it("counts a crop card's crops with no times sign, with the rule and the set box as every card", () => {
  const view: SpecialView = {
    ...baseView(),
    kind: "crop",
    name: "Stickreed",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [], outputs: [port("output", 1)] }],
    power: undefined,
    count: countOf("any", undefined, 12, { noTimes: true }),
  };
  const { container } = renderCard(view);
  const count = container.querySelector(".cc-count")!;
  expect(count.getAttribute("data-run")).toBe("12");
  expect(count.querySelector(".cc-rule")!.textContent).toBe("Any");
  expect(count.getAttribute("data-set")).toBe("Set");
  cleanup();
  const upTo = renderCard({
    ...view,
    count: countOf("upTo", 16, 12, { noTimes: true }),
  });
  const set = upTo.container.querySelector(".cc-count")!;
  expect(set.getAttribute("data-run")).toBe("12");
  expect(set.getAttribute("data-set")).toBe("16");
  expect(upTo.container.querySelector(".cc-rule")!.textContent).toBe("Up to");
});

it("puts a generator's bar under its warnings", () => {
  const count = countOf("upTo", 2, 2);
  const outputs = [port("output", 1, "n1", "power")];
  const view: SpecialView = {
    ...baseView(),
    kind: "power",
    name: "Large Gas Turbine",
    nameTone: "power",
    hasPicker: false,
    amps: undefined,
    tier: undefined,
    sections: [{ section: 0, inputs: [port("input", 1)], outputs }],
    power: undefined,
    warnings: ["Rotor too weak for this fuel."],
    count,
    foot: buildFootView(
      count,
      { capacity: 2, reached: 2, reason: "FULL" },
      { inputs: [], outputs },
    ),
  };
  const { container } = renderCard(view, {
    ...context,
    sheet: { kind: "rows", rows: [] },
  } as typeof context);
  const foot = container.querySelector<HTMLElement>(".cc-foot")!;
  expect(foot.getAttribute("data-word")).toBe("FULL");
  // Rails 2, the strip 3, the warnings 4, the bar 5.
  expect(foot.style.gridRow).toBe("5");
  expect(container.querySelectorAll("*").length).toBeLessThanOrEqual(PLAIN_BUDGET);
});

it("marks a special card in a ring as the plain card is marked", () => {
  const { container } = renderCard({ ...baseView(), loop: "clog" });
  expect(container.querySelector(".cc-card")!.getAttribute("data-loop")).toBe("clog");
});
