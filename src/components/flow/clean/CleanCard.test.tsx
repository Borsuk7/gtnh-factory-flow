// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { setSpillHover, useSpillHover } from "./interaction/spill-hover";
import { ReactFlowProvider } from "@xyflow/react";
import type { FactoryNode, Recipe, ResourceKind } from "@/lib/model/types";
import type { RailPort } from "../node-verdict";
import { CleanCard, StripChip } from "./CleanCard";
import { writeDeviceSettings } from "@/lib/device-settings";
import { readBoardMotionSnapshot, writeBoardMotion } from "../board-motion";
import type {
  CleanCardActions,
  CleanCardContext,
  CleanCardView,
  CleanPortView,
} from "./clean-model";
import { buildCountView, buildFootView, layoutStrip, LIVE_TYPE_MS, reasonStripes } from "./clean-model";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false }));

const sfx = vi.hoisted(() => ({ sfxClick: vi.fn(), playEditSfx: vi.fn() }));
vi.mock("@/lib/sound/sfx", async (original) => ({
  ...(await original<typeof import("@/lib/sound/sfx")>()),
  sfxClick: sfx.sfxClick,
  playEditSfx: sfx.playEditSfx,
}));

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
 * The most elements one reference card may cost: 3 inputs + power + 2 outputs + 2 chips + 3 strip chips + the circuit
 * badge in the well + the count's rule word, which every rule shows (69). An Up to card with its bar along the foot
 * costs one more: 70. The set box is the count's `::after`, no element.
 */
const BUDGET = 70;

function port(side: "input" | "output", n: number, kind: ResourceKind = "item"): CleanPortView {
  const resource = {
    kind,
    id: `mock:${side}${n}`,
    amount: 1,
    displayName: `Resource ${side} ${n}`,
    iconPath: "/mock.png",
  };
  const rail = {
    side,
    key: `${side}:${n}`,
    kind,
    resourceId: resource.id,
    displayName: resource.displayName,
    handleId: `${side}:${kind}:${resource.id}`,
    resource,
    connected: n !== 3,
    currentPerSecond: 1.5,
  } as unknown as RailPort;
  return {
    key: rail.key,
    nodeId: "n1",
    handleId: rail.handleId,
    side,
    port: rail,
    number: "900",
    perSecond: 1.5,
    unit: "/hr",
    name: resource.displayName,
    title: resource.displayName,
    zero: false,
    gold: n === 1,
    numberSmall: false,
    nameSmall: false,
    nameClipped: false,
    wired: rail.connected,
    choice: n === 2,
    resourceKey: `${kind}:${resource.id}`,
    forced: undefined,
  };
}

const count = (
  rule: "any" | "upTo" | "exact",
  pin: number | undefined,
  value: number,
  unset = false,
) =>
  buildCountView({
    rule,
    pin,
    pinned: rule !== "any",
    value,
    needed: value,
    unset,
    upTo: undefined,
  });

function referenceView(): CleanCardView {
  const strip = layoutStrip([
    { id: "heatingCoil", label: "Coil", value: "Nichrome", title: "" },
    { id: "p", label: "Parallel", value: "×4", reading: true, title: "" },
    { id: "oc", label: "Perfect OC", value: "on", title: "" },
  ]);
  return {
    nodeId: "n1",
    name: "Electric Blast Furnace",
    nameSize: 14,
    hasPicker: true,
    tier: { label: "EV", fixed: false, title: "" },
    amps: { label: "4A", value: 4, editable: true },
    inputs: [port("input", 1), port("input", 2), port("input", 3)],
    outputs: [port("output", 1), port("output", 2)],
    power: { number: "6.93k", unit: "EU/t", name: "Power", stalled: false, title: "" },
    art: "/power-art/electric-blast-furnace.png",
    count: count("any", undefined, 1.2, true),
    circuit: {
      setting: "2",
      resource: {
        kind: "item",
        id: "mock:circuit",
        amount: 1,
        displayName: "Programmed Circuit",
        iconPath: "/c.png",
      },
    } as CleanCardView["circuit"],
    chips: strip.chips,
    stripHeight: strip.height,
    selected: false,
    cannotRun: false,
    unset: true,
  };
}

/** The reference card as an Up to card held back by its first input, its bar along the foot. */
function upToView(): CleanCardView {
  const view = referenceView();
  const upToCount = count("upTo", 24, 18.2);
  return {
    ...view,
    unset: false,
    count: upToCount,
    foot: buildFootView(
      upToCount,
      { capacity: 24, reached: 18.2, reason: "STARVED", resourceKey: "item:mock:input1" },
      { inputs: view.inputs, outputs: view.outputs },
    ),
  };
}

function actionsSpy(): CleanCardActions {
  return {
    stepTier: vi.fn(),
    setAmps: vi.fn(),
    cycleMachine: vi.fn(),
    switchMachine: vi.fn(),
    setCount: vi.fn(),
    stepCount: vi.fn(),
    setRule: vi.fn(),
    stepSetting: vi.fn(),
  };
}
const context = {
  machineHandlers: [],
  selectedMachineHandler: { id: "ebf", label: "Electric Blast Furnace" },
  settings: [],
  handleIds: [],
} as unknown as CleanCardContext;
const recipe = { id: "r" } as unknown as Recipe;
const node = { id: "n1" } as unknown as FactoryNode;

function renderCard(view: CleanCardView, actions: CleanCardActions = actionsSpy()) {
  return render(
    <ReactFlowProvider>
      <CleanCard view={view} actions={actions} context={context} recipe={recipe} node={node} />
    </ReactFlowProvider>,
  );
}

it("animates a solved count and port rate, then snaps when Live numbers is turned off", () => {
  vi.useFakeTimers();
  const originalMotion = readBoardMotionSnapshot();
  writeBoardMotion({ valueMotion: true });
  try {
    const view = referenceView();
    const { container, rerender, unmount } = renderCard(view);
    const updated = {
      ...view,
      count: count("any", undefined, 6),
      outputs: [{ ...view.outputs[0]!, number: "5", perSecond: 5 }, ...view.outputs.slice(1)],
    };
    rerender(
      <ReactFlowProvider>
        <CleanCard view={updated} actions={actionsSpy()} context={context} recipe={recipe} node={node} />
      </ReactFlowProvider>,
    );
    const reading = container.querySelector('[data-side="output"] .cc-num')!;
    const countBox = container.querySelector(".cc-count")!;
    expect(countBox.getAttribute("data-run")).toBe("×1.2");
    expect(reading.textContent).toBe("1.5");
    act(() => vi.advanceTimersByTime(250));
    expect(Number(countBox.getAttribute("data-run")!.slice(1))).toBeGreaterThan(1.2);
    expect(Number(countBox.getAttribute("data-run")!.slice(1))).toBeLessThan(6);
    expect(Number(reading.textContent)).toBeGreaterThan(1.5);
    expect(Number(reading.textContent)).toBeLessThan(5);
    act(() => writeBoardMotion({ valueMotion: false }));
    expect(countBox.getAttribute("data-run")).toBe("×6");
    expect(reading.textContent).toBe("5");
    unmount();
  } finally {
    writeBoardMotion(originalMotion);
    vi.useRealTimers();
  }
});

it("lights a spill's Forced tile with the rest of the spill, and lights the rest from its own row", () => {
  const view = referenceView();
  view.outputs = [
    { ...view.outputs[0]!, forced: { number: "5", unit: "/s", perSecond: 5 }, spillTo: "buf" },
    ...view.outputs.slice(1),
  ];
  const { container } = renderCard(view);
  const tile = () => container.querySelector(".cc-forced")!;
  expect(tile().hasAttribute("data-lit")).toBe(false);
  // The buffer's own tile (or another maker's row) under the pointer.
  act(() => setSpillHover("buf"));
  expect(tile().hasAttribute("data-lit")).toBe(true);
  act(() => setSpillHover("other"));
  expect(tile().hasAttribute("data-lit")).toBe(false);
  act(() => setSpillHover(undefined));
  // This row under the pointer names its buffer.
  const row = container.querySelector(".cc-row[data-forced]")!;
  fireEvent.pointerEnter(row);
  expect(useSpillHover.getState().drawerId).toBe("buf");
  fireEvent.pointerLeave(row);
  expect(useSpillHover.getState().drawerId).toBeUndefined();
});

it("costs at most 70 elements for the reference card", () => {
  const { container } = renderCard(referenceView());
  const elements = container.querySelectorAll("*").length;
  // The count is part of the contract: print it so a PR can quote it.
  console.info(`[clean card] reference card DOM elements: ${elements}`);
  expect(elements).toBeLessThanOrEqual(BUDGET);
});

it("costs at most 70 elements as an Up to card with its bar", () => {
  const { container } = renderCard(upToView());
  const elements = container.querySelectorAll("*").length;
  console.info(`[clean card] Up to reference card with its bar, DOM elements: ${elements}`);
  expect(container.querySelector(".cc-foot")).not.toBeNull();
  expect(elements).toBeLessThanOrEqual(BUDGET);
});

it("keeps every control a div, so the button font rule cannot reach it", () => {
  const { container } = renderCard(upToView());
  expect(container.querySelectorAll("button, input, select, textarea").length).toBe(0);
});

it("says what runs big, and under it the rule and the set box for every rule, through data attributes", () => {
  const { container } = renderCard(referenceView());
  const any = container.querySelector(".cc-count")!;
  expect(any.getAttribute("data-run")).toBe("×1.2");
  // Any says so, with an empty box asking for a count while nothing sets this part of the plan.
  expect(any.querySelector(".cc-rule")!.textContent).toBe("Any");
  expect(any.getAttribute("data-set")).toBe("Set");
  expect(any.hasAttribute("data-pinned")).toBe(false);
  expect(any.hasAttribute("data-prompt")).toBe(true);
  cleanup();
  const quiet = renderCard({ ...referenceView(), unset: false, count: count("any", undefined, 1.2) });
  const settled = quiet.container.querySelector(".cc-count")!;
  expect(settled.querySelector(".cc-rule")!.textContent).toBe("Any");
  expect(settled.getAttribute("data-set")).toBe("Set");
  expect(settled.hasAttribute("data-prompt")).toBe(false);
  cleanup();

  const upTo = renderCard(upToView()).container.querySelector(".cc-count")!;
  expect(upTo.getAttribute("data-run")).toBe("×18.2");
  expect(upTo.getAttribute("data-set")).toBe("24");
  expect(upTo.getAttribute("data-rule")).toBe("upTo");
  expect(upTo.hasAttribute("data-pinned")).toBe(true);
  expect(upTo.hasAttribute("data-prompt")).toBe(false);
  expect(upTo.querySelector(".cc-rule")!.textContent).toBe("Up to");
  cleanup();

  const exact = renderCard({
    ...referenceView(),
    unset: false,
    count: count("exact", 24, 24),
  }).container;
  expect(exact.querySelector(".cc-rule")!.textContent).toBe("Exactly");
  expect(exact.querySelector(".cc-count")!.getAttribute("data-set")).toBe("24");
  // An Exactly card with nothing forced has no bar; neither has an Any card.
  expect(exact.querySelector(".cc-foot")).toBeNull();
});

it("types a count into an Any card's box, which opens empty", () => {
  const actions = actionsSpy();
  const { container } = renderCard(referenceView(), actions);
  fireEvent.click(container.querySelector(".cc-count")!);
  const input = container.querySelector<HTMLInputElement>(".cc-count input")!;
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { value: "4" } });
  fireEvent.blur(input);
  // The card's own rule for a typed count decides Up to (pinActions), as the overview's box does (pinCount).
  expect(actions.setCount).toHaveBeenCalledWith(4);
});

it("opens Any, Up to, Exactly from the rule word and sends the pick", () => {
  const actions = actionsSpy();
  const { container } = renderCard(upToView(), actions);
  fireEvent.click(container.querySelector(".cc-rule")!);
  const rows = [...document.querySelectorAll('[role="menuitemradio"]')];
  expect(rows.map((row) => row.querySelector(".cm-name")!.textContent)).toEqual([
    "Any",
    "Up to",
    "Exactly",
  ]);
  expect(rows[1]!.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(rows[2]!);
  expect(actions.setRule).toHaveBeenCalledWith("exact");
  // The rule word's click is its own: it never starts typing a count.
  expect(container.querySelector(".cc-count input")).toBeNull();
});

it("types a count on a click, steps it on the wheel and goes back to Any on a middle click", () => {
  const actions = actionsSpy();
  const { container } = renderCard(upToView(), actions);
  const block = container.querySelector(".cc-count")!;
  fireEvent.wheel(block, { deltaY: -100 });
  expect(actions.stepCount).toHaveBeenCalledWith(1);
  fireEvent.wheel(block, { deltaY: 100 });
  expect(actions.stepCount).toHaveBeenCalledWith(-1);
  fireEvent(block, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(actions.setCount).toHaveBeenCalledWith(undefined);
  fireEvent.click(block);
  const input = container.querySelector<HTMLInputElement>(".cc-count input")!;
  expect(input.value).toBe("24");
  fireEvent.change(input, { target: { value: "30" } });
  fireEvent.blur(input);
  expect(actions.setCount).toHaveBeenLastCalledWith(30);
});

it("sets what the open box holds as it goes: each wheel step at once, typing once it rests", () => {
  vi.useFakeTimers();
  try {
    const actions = actionsSpy();
    const { container } = renderCard(upToView(), actions);
    const block = container.querySelector(".cc-count")!;
    const input = () => container.querySelector<HTMLInputElement>(".cc-count input");
    fireEvent.click(block);
    // The wheel over the open box is the box's: the page does not zoom and the board's camera never sees it.
    const wheel = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    fireEvent(input()!, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(input()!.value).toBe("25");
    expect(actions.setCount).toHaveBeenLastCalledWith(25);
    fireEvent.wheel(input()!, { deltaY: -100 });
    expect(input()!.value).toBe("26");
    expect(actions.setCount).toHaveBeenLastCalledWith(26);
    // The box stays open for more, and the closed box's own step is never used.
    expect(input()).not.toBeNull();
    expect(actions.stepCount).not.toHaveBeenCalled();

    // Typing is set once it rests, not on each key: "1" then "12" sets 12 alone.
    vi.mocked(actions.setCount).mockClear();
    fireEvent.change(input()!, { target: { value: "1" } });
    vi.advanceTimersByTime(100);
    fireEvent.change(input()!, { target: { value: "12" } });
    expect(actions.setCount).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIVE_TYPE_MS);
    expect(vi.mocked(actions.setCount).mock.calls).toEqual([[12]]);
    // An emptied box is a count being retyped: nothing is cleared while typing.
    fireEvent.change(input()!, { target: { value: "" } });
    vi.advanceTimersByTime(LIVE_TYPE_MS);
    expect(vi.mocked(actions.setCount).mock.calls).toEqual([[12]]);

    // Escape closes the box and puts back the count it opened with; a blur as the box goes sets nothing more.
    const box = input()!;
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.blur(box);
    expect(input()).toBeNull();
    expect(actions.setCount).toHaveBeenLastCalledWith(24);
    expect(actions.setCount).toHaveBeenCalledTimes(2);

    // Enter sets what is typed at once, without waiting for the typing to rest.
    fireEvent.click(block);
    fireEvent.change(input()!, { target: { value: "9" } });
    fireEvent.keyDown(input()!, { key: "Enter" });
    expect(input()).toBeNull();
    expect(actions.setCount).toHaveBeenLastCalledWith(9);
    vi.advanceTimersByTime(LIVE_TYPE_MS);
    expect(actions.setCount).toHaveBeenCalledTimes(3);

    // Opened and let go of unchanged: no write. Escape with nothing set: no write. Emptied or zero, let go: cleared.
    fireEvent.click(block);
    fireEvent.blur(input()!);
    fireEvent.click(block);
    fireEvent.keyDown(input()!, { key: "Escape" });
    expect(actions.setCount).toHaveBeenCalledTimes(3);
    fireEvent.click(block);
    fireEvent.change(input()!, { target: { value: "0" } });
    fireEvent.blur(input()!);
    expect(actions.setCount).toHaveBeenLastCalledWith(undefined);
  } finally {
    vi.useRealTimers();
  }
});

it("puts an Any card back to Any on Escape after the box set a count", () => {
  vi.useFakeTimers();
  try {
    const actions = actionsSpy();
    const { container } = renderCard(referenceView(), actions);
    fireEvent.click(container.querySelector(".cc-count")!);
    const input = container.querySelector<HTMLInputElement>(".cc-count input")!;
    fireEvent.change(input, { target: { value: "4" } });
    vi.advanceTimersByTime(LIVE_TYPE_MS);
    expect(actions.setCount).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(actions.setRule).toHaveBeenLastCalledWith("any");
  } finally {
    vi.useRealTimers();
  }
});

it("steps on the wheel only while Scroll changes values is on; off, the wheel is left for the board to zoom", () => {
  const wheelOver = (element: Element) => {
    const event = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    let reachedDocument = false;
    const seen = () => {
      reachedDocument = true;
    };
    document.addEventListener("wheel", seen);
    element.dispatchEvent(event);
    document.removeEventListener("wheel", seen);
    return { event, reachedDocument };
  };
  const controls = (container: HTMLElement) => ({
    count: container.querySelector(".cc-count")!,
    tier: container.querySelector('.cc-chip[aria-label^="Tier"]')!,
    amps: container.querySelector('.cc-head .cc-chip:not([aria-label^="Tier"])')!,
    name: container.querySelector(".cc-name")!,
  });
  const calls = (actions: CleanCardActions) => [
    actions.stepCount,
    actions.stepTier,
    actions.setAmps,
    actions.cycleMachine,
  ];
  // A setting chip on the strip steps through the store, so it is drawn on its own.
  const settingChip = (onStep: () => void) =>
    render(
      <StripChip
        chip={{ id: "heatingCoil", label: "Coil", value: "Nichrome", x: 0, y: 0, width: 80, title: "" }}
        nodeId="n1"
        onStep={onStep}
        onOpen={vi.fn()}
        wasClick={() => true}
      />,
    ).container.querySelector(".cc-sc")!;

  const on = actionsSpy();
  const onCard = renderCard(upToView(), on);
  for (const element of Object.values(controls(onCard.container))) {
    // Each one takes the wheel from the board: the event stops at the control.
    expect(element.hasAttribute("data-wheel-value")).toBe(true);
    expect(wheelOver(element).reachedDocument).toBe(false);
  }
  for (const call of calls(on)) expect(call).toHaveBeenCalledTimes(1);
  cleanup();
  const stepOn = vi.fn();
  const chipOn = settingChip(stepOn);
  expect(chipOn.hasAttribute("data-wheel-value")).toBe(true);
  expect(wheelOver(chipOn).reachedDocument).toBe(false);
  expect(stepOn).toHaveBeenCalledWith("heatingCoil", 1);
  cleanup();

  writeDeviceSettings({ scrollChangesValues: false });
  try {
    const off = actionsSpy();
    const offCard = renderCard(upToView(), off);
    for (const element of Object.values(controls(offCard.container))) {
      const { event, reachedDocument } = wheelOver(element);
      expect(event.defaultPrevented).toBe(false);
      expect(reachedDocument).toBe(true);
    }
    for (const call of calls(off)) expect(call).not.toHaveBeenCalled();
    cleanup();
    const stepOff = vi.fn();
    const chipOff = settingChip(stepOff);
    expect(wheelOver(chipOff).reachedDocument).toBe(true);
    expect(stepOff).not.toHaveBeenCalled();
  } finally {
    writeDeviceSettings({ scrollChangesValues: true });
  }
});

it("sounds for itself: a click that opens the editor or the rule menu clicks, each wheel step ticks", () => {
  sfx.sfxClick.mockClear();
  sfx.playEditSfx.mockClear();
  const actions = actionsSpy();
  const { container } = renderCard(upToView(), actions);
  const block = container.querySelector(".cc-count")!;
  // The page's own click stands down for it.
  expect(block.hasAttribute("data-sfx-own")).toBe(true);
  fireEvent.wheel(block, { deltaY: -100 });
  fireEvent.wheel(block, { deltaY: 100 });
  expect(sfx.playEditSfx.mock.calls).toEqual([
    ["ui.tick", 1, 1.12],
    ["ui.tick", 1, 0.9],
  ]);
  fireEvent.click(container.querySelector(".cc-rule")!);
  expect(sfx.sfxClick).toHaveBeenCalledTimes(1);
  sfx.playEditSfx.mockClear();
  fireEvent(block, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(sfx.playEditSfx.mock.calls).toEqual([["board.unpin"]]);
  expect(actions.setCount).toHaveBeenLastCalledWith(undefined);
  cleanup();
  const again = renderCard(upToView(), actions);
  fireEvent.click(again.container.querySelector(".cc-count")!);
  expect(sfx.sfxClick).toHaveBeenCalledTimes(2);
});

it("outlines a problem card in its bar's tone, and leaves Any and a full card alone", () => {
  const starved = renderCard(upToView()).container.querySelector(".cc-card")!;
  expect(starved.getAttribute("data-tone")).toBe("starved");
  cleanup();
  const any = renderCard(referenceView()).container.querySelector(".cc-card")!;
  expect(any.hasAttribute("data-tone")).toBe(false);
  cleanup();
  const view = referenceView();
  const fullCount = count("upTo", 24, 24);
  const full = renderCard({
    ...view,
    count: fullCount,
    foot: buildFootView(
      fullCount,
      { capacity: 24, reached: 24, reason: "FULL" },
      { inputs: view.inputs, outputs: view.outputs },
    ),
  }).container.querySelector(".cc-card")!;
  expect(full.hasAttribute("data-tone")).toBe(false);
  cleanup();
  const exactCount = count("exact", 24, 24);
  const fed = [
    { ...view.inputs[0]!, forced: { number: "720", unit: "L/s", perSecond: 720 } },
    ...view.inputs.slice(1),
  ];
  const forced = renderCard({
    ...view,
    inputs: fed,
    count: exactCount,
    foot: buildFootView(exactCount, undefined, { inputs: fed, outputs: view.outputs }),
  }).container.querySelector(".cc-card")!;
  expect(forced.getAttribute("data-tone")).toBe("forced");
});

it("draws its Up to bar on the zoomed-out face, one element", () => {
  const { container } = renderCard({
    ...upToView(),
    glance: { tone: "starved", fill: 0.76, word: "STARVED" },
  });
  const glance = container.querySelector<HTMLElement>(".cc-glance")!;
  expect(glance.children.length).toBe(0);
  expect(glance.getAttribute("data-bar")).toBe("");
  expect(glance.getAttribute("data-tone")).toBe("starved");
  expect(glance.textContent).toBe("STARVED");
  expect(glance.style.getPropertyValue("--glance-fill")).toBe("76%");
  cleanup();
  const plain = renderCard(referenceView()).container.querySelector(".cc-glance")!;
  expect(plain.hasAttribute("data-bar")).toBe(false);
  expect(plain.textContent).toBe("");
});

it("keeps the normal edge with Problem outlines off, and the ring's outline either way", () => {
  writeDeviceSettings({ problemOutlines: false });
  try {
    const card = renderCard({ ...upToView(), loop: "dead" }).container.querySelector(".cc-card")!;
    expect(card.hasAttribute("data-tone")).toBe(false);
    expect(card.getAttribute("data-loop")).toBe("dead");
    // The bar and its colour stay.
    expect(card.querySelector(".cc-foot")!.getAttribute("data-tone")).toBe("starved");
  } finally {
    writeDeviceSettings({ problemOutlines: true });
  }
});

it("marks a card in a ring so its outline pulses in the ring's tone", () => {
  const dead = renderCard({ ...upToView(), loop: "dead" }).container.querySelector(".cc-card")!;
  expect(dead.getAttribute("data-loop")).toBe("dead");
  cleanup();
  const clog = renderCard({ ...upToView(), loop: "clog" }).container.querySelector(".cc-card")!;
  expect(clog.getAttribute("data-loop")).toBe("clog");
  cleanup();
  const none = renderCard(upToView()).container.querySelector(".cc-card")!;
  expect(none.hasAttribute("data-loop")).toBe(false);
});

it("lights the row its reason names", () => {
  const view = upToView();
  const lit = {
    ...view,
    inputs: view.inputs.map((p, i) => (i === 0 ? { ...p, why: "starved" as const } : p)),
  };
  const { container } = renderCard(lit);
  const rows = [...container.querySelectorAll<HTMLElement>(".cc-row[data-port]")];
  expect(rows.map((row) => row.getAttribute("data-why"))).toEqual([
    "starved",
    null,
    null,
    null,
    null,
  ]);
  // Striped in the reason's own mixes, as a free end is in its own.
  expect(rows[0]!.style.getPropertyValue("--cc-why-body")).toBe(reasonStripes("starved")!.body);
  expect(rows[0]!.style.getPropertyValue("--cc-why-stripe")).toBe(reasonStripes("starved")!.stripe);
  expect(rows[1]!.getAttribute("style")).toBeNull();
});

it("keeps each editor the size of what it replaces", () => {
  const { container } = renderCard(upToView());
  fireEvent.click(container.querySelector(".cc-count")!);
  const count = container.querySelector<HTMLInputElement>(".cc-count input")!;
  // "24": three characters and the box's padding, not the input's own wide default.
  expect(count.style.width).toBe("calc(3ch + 8px)");
  fireEvent.change(count, { target: { value: "1250" } });
  expect(count.style.width).toBe("calc(5ch + 8px)");
  fireEvent.blur(count);
  const amps = container.querySelector<HTMLElement>('.cc-head .cc-chip:not([aria-label^="Tier"])')!;
  Object.defineProperty(amps, "offsetWidth", { configurable: true, value: 48 });
  fireEvent.click(amps);
  expect(amps.hasAttribute("data-editing")).toBe(true);
  expect(amps.style.width).toBe("48px");
  expect(amps.querySelector("input")!.getAttribute("size")).toBe("1");
});

it("puts the circuit in the well's corner: its own icon and its tip, no number drawn on it, no row", () => {
  const { container } = renderCard(referenceView());
  const badge = container.querySelector<HTMLElement>(".cc-pic > .cc-circuit")!;
  expect(badge.hasAttribute("data-n")).toBe(false);
  expect(badge.querySelector(".cc-circuit-icon")).not.toBeNull();
  expect(JSON.parse(badge.getAttribute("data-tip")!).title).toBe("Circuit 2");
  expect(badge.textContent).toBe("");
  expect([...container.querySelectorAll(".cc-pname")].map((el) => el.textContent)).not.toContain(
    "Circuit",
  );
});

it("draws the bar as one element: tone, word, line and fraction", () => {
  const { container } = renderCard(upToView());
  const foot = container.querySelector<HTMLElement>(".cc-foot")!;
  expect(foot.children.length).toBe(0);
  expect(foot.getAttribute("data-tone")).toBe("starved");
  expect(foot.getAttribute("data-word")).toBe("STARVED");
  expect(foot.getAttribute("data-frac")).toBe("18.2 / 24");
  expect(foot.textContent).toBe("short of Resource input 1");
  expect(foot.style.getPropertyValue("--fill")).toMatch(/^\d+px$/);
  expect(foot.hasAttribute("data-tip")).toBe(true);
});

it("marks an unwired port and a card that cannot run", () => {
  const { container } = renderCard({ ...referenceView(), cannotRun: true, selected: true });
  expect(container.querySelectorAll('.cc-row[data-wired="false"]').length).toBe(1);
  const card = container.querySelector(".cc-card")!;
  expect(card.hasAttribute("data-cannot-run")).toBe(true);
  expect(card.hasAttribute("data-selected")).toBe(true);
});

it("keeps every port row a wire anchor with its handle", () => {
  const { container } = renderCard(upToView());
  const rows = container.querySelectorAll('.cc-row[data-port][data-resource-edge-anchor="true"]');
  expect(rows.length).toBe(5);
  for (const row of rows) expect(row.querySelector(".react-flow__handle")).not.toBeNull();
});

it("lays strip chips out on whole-cell rows inside the card", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    label: "Setting",
    value: `value ${i}`,
    title: "",
  }));
  const { chips, height } = layoutStrip(many);
  expect(height % 20).toBe(0);
  for (const chip of chips) {
    expect(chip.x).toBeGreaterThanOrEqual(8);
    expect(chip.x + chip.width).toBeLessThanOrEqual(320 - 8);
    expect((chip.y - 10) % 20).toBe(0);
  }
  expect(layoutStrip([]).height).toBe(0);
});
