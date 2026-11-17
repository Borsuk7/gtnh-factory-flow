// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CleanPortView } from "../clean-model";

const updateNode = vi.fn();
const state = {
  isReadOnly: false,
  checklistMode: false,
  updateNode,
  project: { nodes: [{ id: "n1", portRates: undefined as Record<string, number> | undefined }] },
};
vi.mock("@/store/factory-store", () => ({
  useFactoryStore: Object.assign(() => undefined, { getState: () => state }),
  useRateDisplayUnits: () => undefined,
}));

const sfx = vi.hoisted(() => ({ playEditSfx: vi.fn() }));
vi.mock("@/lib/sound/sfx", async (original) => ({
  ...(await original<typeof import("@/lib/sound/sfx")>()),
  playEditSfx: sfx.playEditSfx,
}));

import { PortRateControls } from "./PortRateControls";

function port(over: Partial<CleanPortView> = {}): CleanPortView {
  return {
    key: "k",
    nodeId: "n1",
    handleId: "input:item:iron",
    side: "input",
    port: { kind: "item", currentPerSecond: 2.5, resource: {} } as unknown as CleanPortView["port"],
    number: "2.5",
    perSecond: 2.5,
    unit: "/s",
    name: "Iron Ingot",
    title: "",
    zero: false,
    gold: false,
    numberSmall: false,
    nameSmall: false,
    nameClipped: false,
    wired: false,
    choice: false,
    resourceKey: "item:iron",
    ...over,
  };
}

const yes = () => true;

beforeEach(() => {
  updateNode.mockReset();
  state.isReadOnly = false;
  state.checklistMode = false;
  state.project.nodes[0]!.portRates = undefined;
});
afterEach(cleanup);

it("costs two elements, the key and the box", () => {
  const { container } = render(<PortRateControls p={port()} unset={false} wasClick={yes} />);
  expect(container.querySelectorAll("*").length).toBe(2);
});

it("shows Set, pulsing while the part is unset, and the rate once set", () => {
  const unset = render(<PortRateControls p={port()} unset wasClick={yes} />);
  const box = unset.container.querySelector(".cc-prb")!;
  expect(box.textContent).toBe("Set");
  expect(box.hasAttribute("data-prompt")).toBe(true);
  cleanup();
  const calm = render(<PortRateControls p={port()} unset={false} wasClick={yes} />);
  expect(calm.container.querySelector(".cc-prb")!.hasAttribute("data-prompt")).toBe(false);
  cleanup();
  const set = render(<PortRateControls p={port({ rate: 0.5, gold: true })} unset wasClick={yes} />);
  const setBox = set.container.querySelector(".cc-prb")!;
  expect(setBox.hasAttribute("data-set")).toBe(true);
  expect(setBox.hasAttribute("data-prompt")).toBe(false);
  expect(set.container.querySelector(".cc-prk")!.getAttribute("data-mode")).toBe("exact");
});

it("the key pins the port at the rate it runs at now, and clears it again", () => {
  const first = render(<PortRateControls p={port()} unset={false} wasClick={yes} />);
  fireEvent.click(first.container.querySelector(".cc-prk")!);
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: { "input:item:iron": 2.5 } });
  cleanup();
  state.project.nodes[0]!.portRates = { "input:item:iron": 2.5 };
  const second = render(<PortRateControls p={port({ rate: 2.5 })} unset={false} wasClick={yes} />);
  fireEvent.click(second.container.querySelector(".cc-prk")!);
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: undefined });
});

it("does nothing on a press that moved (a drag carries the card)", () => {
  const { container } = render(
    <PortRateControls p={port()} unset={false} wasClick={() => false} />,
  );
  fireEvent.click(container.querySelector(".cc-prk")!);
  fireEvent.click(container.querySelector(".cc-prb")!);
  expect(updateNode).not.toHaveBeenCalled();
  expect(container.querySelector("input")).toBeNull();
});

it("the box types a rate, shorthand and fractions included, and Escape cancels", () => {
  const { container } = render(<PortRateControls p={port()} unset={false} wasClick={yes} />);
  fireEvent.click(container.querySelector(".cc-prb")!);
  let input = container.querySelector("input")!;
  fireEvent.change(input, { target: { value: "2k" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: { "input:item:iron": 2000 } });
  updateNode.mockReset();
  fireEvent.click(container.querySelector(".cc-prb")!);
  input = container.querySelector("input")!;
  fireEvent.change(input, { target: { value: "9" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);
  expect(updateNode).not.toHaveBeenCalled();
});

it("an empty box commits Any (clears a set rate)", () => {
  state.project.nodes[0]!.portRates = { "input:item:iron": 4 };
  const { container } = render(
    <PortRateControls p={port({ rate: 4 })} unset={false} wasClick={yes} />,
  );
  fireEvent.click(container.querySelector(".cc-prb")!);
  const input = container.querySelector("input")!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: undefined });
});

it("the wheel steps the rate by 1 (Ctrl 10) and clears below 1; a middle click clears", () => {
  state.project.nodes[0]!.portRates = { "input:item:iron": 5 };
  const { container } = render(
    <PortRateControls p={port({ rate: 5 })} unset={false} wasClick={yes} />,
  );
  const box = container.querySelector(".cc-prb")!;
  fireEvent.wheel(box, { deltaY: -100 });
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: { "input:item:iron": 6 } });
  fireEvent.wheel(box, { deltaY: 100, ctrlKey: true });
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: undefined });
  updateNode.mockReset();
  sfx.playEditSfx.mockClear();
  // The middle button never starts the browser's autoscroll, and its click clears with the board's unpin sound.
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
  box.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  expect(updateNode).not.toHaveBeenCalled();
  fireEvent(box, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: undefined });
  expect(sfx.playEditSfx).toHaveBeenCalledWith("board.unpin");
});

it("the rule key clears on the middle button too, and nothing sounds when nothing was set", () => {
  state.project.nodes[0]!.portRates = { "input:item:iron": 5 };
  const set = render(<PortRateControls p={port({ rate: 5 })} unset={false} wasClick={yes} />);
  fireEvent(
    set.container.querySelector(".cc-prk")!,
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  expect(updateNode).toHaveBeenLastCalledWith("n1", { portRates: undefined });
  cleanup();
  updateNode.mockReset();
  sfx.playEditSfx.mockClear();
  const empty = render(<PortRateControls p={port()} unset={false} wasClick={yes} />);
  fireEvent(
    empty.container.querySelector(".cc-prb")!,
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  expect(updateNode).not.toHaveBeenCalled();
  expect(sfx.playEditSfx).not.toHaveBeenCalled();
});

it("changes nothing in a read-only plan", () => {
  state.isReadOnly = true;
  const { container } = render(<PortRateControls p={port()} unset={false} wasClick={yes} />);
  fireEvent.click(container.querySelector(".cc-prk")!);
  fireEvent.click(container.querySelector(".cc-prb")!);
  fireEvent.wheel(container.querySelector(".cc-prb")!, { deltaY: -100 });
  expect(updateNode).not.toHaveBeenCalled();
  expect(container.querySelector("input")).toBeNull();
});
