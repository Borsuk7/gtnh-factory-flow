// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNetworkStore } from "@/store/network-store";
import { useFactoryStore } from "@/store/factory-store";
import { memberKey, type PlanFlows } from "@/lib/networks/model";
import { NetworkPage } from "./NetworkPage";

const mocks = vi.hoisted(() => ({ flows: new Map<string, PlanFlows>() }));
vi.mock("@/lib/networks/calculation", () => ({
  useNetworkCalculations: () => mocks.flows,
  localDesignId: (member: { designId: string }) => member.designId,
}));

const originalEdit = useNetworkStore.getState().edit;
afterEach(() => {
  cleanup();
  useNetworkStore.setState({ edit: originalEdit });
});

beforeEach(() => {
  const member = { designId: "line", name: "Line", included: true };
  const material = {
    key: "fluid:oxygen",
    kind: "fluid" as const,
    resourceId: "oxygen",
    label: "Oxygen",
    supply: 10,
    demand: 0,
  };
  mocks.flows = new Map([
    [
      memberKey(member),
      {
        materials: [material],
        ports: [{ ...material, portKey: "out", machine: "Machine", side: "out" }],
        power: { used: 0, made: 0 },
      },
    ],
  ]);
  useFactoryStore.getState().setRateUnit("second");
  useNetworkStore.setState({
    activeId: "main",
    edit: vi.fn(async (change) =>
      useNetworkStore.setState((state) => ({
        catalogue: { ...state.catalogue!, networks: change(state.catalogue!.networks) },
      })),
    ),
    catalogue: {
      account: "local",
      token: "t",
      revision: 0,
      dirty: false,
      networks: [{ id: "main", name: "Main", included: true, members: [member], sharing: {} }],
    },
  });
});

it("opens I/O as a modal, traps focus and closes with Escape", () => {
  render(<NetworkPage />);
  const trigger = screen.getByRole("button", { name: "Inputs and outputs for Line" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Inputs and outputs · Line" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.contains(document.activeElement)).toBe(true);
  const close = screen.getByRole("button", { name: "Done" });
  // Last checkbox wraps Tab back to the first control.
  const checkbox = screen.getByRole("checkbox", { name: /Output · Oxygen/ });
  checkbox.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  expect(close).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("changes rate units without changing the solve and uses compact section actions", () => {
  const result = useFactoryStore.getState().lastResult;
  render(<NetworkPage />);
  expect(screen.queryByRole("button", { name: "Back to networks" })).toBeNull();
  expect(screen.getByRole("button", { name: "Add plans" }).textContent).toBe("");
  expect(screen.getByRole("button", { name: "New subnetwork" }).textContent).toBe("");
  fireEvent.change(screen.getByRole("combobox", { name: "Rate unit" }), {
    target: { value: "minute" },
  });
  expect(screen.getAllByText("600 L/min").length).toBeGreaterThan(0);
  expect(useFactoryStore.getState().lastResult).toBe(result);
});

it("organizes plans into collapsible groups without changing totals", () => {
  render(<NetworkPage />);
  fireEvent.click(screen.getByRole("button", { name: "Inputs and outputs for Line" }));
  const group = screen.getByRole("combobox", { name: "Plan group" });
  fireEvent.change(group, { target: { value: "Oxygen lines" } });
  fireEvent.blur(group);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Oxygen lines").closest("details")).toBeTruthy();
  expect(useNetworkStore.getState().catalogue!.networks[0].members[0].group).toBe("Oxygen lines");
  expect(screen.getAllByText("10 L/s").length).toBeGreaterThan(0);
});

it("moves dragged plans into groups and back to Ungrouped while keeping their I/O choices", () => {
  useNetworkStore.setState((state) => ({
    catalogue: {
      ...state.catalogue!,
      networks: [
        {
          ...state.catalogue!.networks[0],
          members: [
            {
              designId: "line",
              name: "Line",
              included: true,
              group: "Source",
              portSelection: ["out"],
            },
            { designId: "other", name: "Other", included: false, group: "Target" },
          ],
        },
      ],
    },
  }));
  render(<NetworkPage />);
  const data = new Map<string, string>();
  const transfer = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
  const dragTo = (name: string) => {
    fireEvent.dragStart(screen.getByRole("group", { name: "Draggable plan Line" }), {
      dataTransfer: transfer,
    });
    const target = screen.getByText(name).closest("details")!;
    expect(fireEvent.dragEnter(target, { dataTransfer: transfer })).toBe(false);
    fireEvent.dragOver(target, { dataTransfer: transfer });
    expect(target.hasAttribute("data-drop-target")).toBe(true);
    fireEvent.drop(target, { dataTransfer: transfer });
  };
  dragTo("Target");
  expect(useNetworkStore.getState().catalogue!.networks[0].members[0]).toMatchObject({
    group: "Target",
    included: true,
    portSelection: ["out"],
  });
  dragTo("Ungrouped");
  expect(useNetworkStore.getState().catalogue!.networks[0].members[0].group).toBeUndefined();
  expect(screen.getAllByText("10 L/s").length).toBeGreaterThan(0);
});

it("ignores external drops", () => {
  useNetworkStore.setState((state) => ({
    catalogue: {
      ...state.catalogue!,
      networks: [
        {
          ...state.catalogue!.networks[0],
          members: [{ designId: "line", name: "Line", included: true, group: "Source" }],
        },
      ],
    },
  }));
  render(<NetworkPage />);
  fireEvent.drop(screen.getByText("Ungrouped").closest("details")!, {
    dataTransfer: { getData: () => memberKey({ designId: "line" }) },
  });
  expect(useNetworkStore.getState().edit).not.toHaveBeenCalled();
});
