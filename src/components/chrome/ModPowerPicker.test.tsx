// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFactoryStore } from "@/store/factory-store";
import { ModPowerPicker } from "./ModPowerPicker";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false }));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const added = { custom: vi.fn(), tank: vi.fn(), crop: vi.fn(), source: vi.fn() };
beforeEach(() => {
  for (const fn of Object.values(added)) fn.mockClear();
  useFactoryStore.setState({
    powerMenuOpen: true,
    addCustomRateNode: added.custom,
    addPowerSourceNode: added.source as never,
    addFluidTankNode: added.tank,
    addCropFarmNode: added.crop,
  } as never);
});
afterEach(() => {
  cleanup();
  useFactoryStore.setState({ powerMenuOpen: false });
});

const titles = () => [...document.querySelectorAll(".mp-brass span")].map((element) => element.textContent);

describe("the non-recipe machines picker", () => {
  it("is the mod's sheet: title, search, the two filter keys and a close key", () => {
    render(<ModPowerPicker />);
    expect(screen.getByRole("dialog", { name: "Non-recipe machines" })).toBeTruthy();
    expect(document.querySelector(".mp-title")?.textContent).toBe("NON-RECIPE MACHINES");
    expect(screen.getByPlaceholderText("Machine, fuel, or product...")).toBeTruthy();
    expect([...document.querySelectorAll(".mp-head .ml-drop")].map((key) => key.textContent)).toEqual(["All types", "All tiers"]);
  });

  it("lists the planning cards first in an Other column, then the power groups in the mod's columns", () => {
    render(<ModPowerPicker />);
    const columns = [...document.querySelectorAll(".mp-col")].map((column) => [...column.querySelectorAll(".mp-brass span")].map((title) => title.textContent));
    expect(columns[0]).toEqual(["OTHER", "GENERATORS"]);
    expect(columns[1]).toEqual(["TURBINES"]);
    expect(columns[3]).toEqual(["ENGINES", "SOLAR"]);
    expect(columns[4]).toEqual(["REACTORS", "ENDGAME"]);
    const other = document.querySelector(".mp-col")!.querySelectorAll(".mp-group")[0];
    expect([...other.querySelectorAll(".mp-tile")].map((tile) => tile.getAttribute("data-source"))).toEqual(["custom-rate", "fluid-tank", "crop-farm", "railcraft-water-tank"]);
    expect(other.querySelector(".mp-brass i")?.textContent).toBe("4");
    // The Railcraft Boiler sits with the other boilers.
    const steam = [...document.querySelectorAll(".mp-group")].find((group) => group.querySelector(".mp-brass span")?.textContent === "BOILERS AND EXCHANGERS")!;
    expect(steam.querySelector('[data-source="railcraft-boiler"]')).toBeTruthy();
  });

  it("picking Custom Rate adds the custom rate card and closes the picker", () => {
    render(<ModPowerPicker />);
    fireEvent.click(document.querySelector('[data-source="custom-rate"]')!);
    expect(added.custom).toHaveBeenCalledTimes(1);
    expect(useFactoryStore.getState().powerMenuOpen).toBe(false);
  });

  it("picking Fluid Tank asks the store for a tank", () => {
    render(<ModPowerPicker />);
    fireEvent.click(document.querySelector('[data-source="fluid-tank"]')!);
    expect(added.tank).toHaveBeenCalledTimes(1);
  });

  it("offers planning cards in the compact sheet without focusing search", () => {
    render(<ModPowerPicker compact />);
    const sheet = screen.getByRole("dialog", { name: "Non-recipe machines" });
    expect(sheet.closest(".mp-backdrop")?.hasAttribute("data-compact")).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "Machine, fuel, or product" }));
    fireEvent.click(screen.getByRole("button", { name: "Crop Farm" }));
    expect(added.crop).toHaveBeenCalledTimes(1);
    expect(useFactoryStore.getState().powerMenuOpen).toBe(false);
  });

  it("picking Crop Farm asks the store for a crop farm and closes the picker", () => {
    render(<ModPowerPicker />);
    fireEvent.click(document.querySelector('[data-source="crop-farm"]')!);
    expect(added.crop).toHaveBeenCalledTimes(1);
    expect(useFactoryStore.getState().powerMenuOpen).toBe(false);
  });

  it("typing searches the machines and what they burn, laid out down the columns", () => {
    render(<ModPowerPicker />);
    fireEvent.change(screen.getByPlaceholderText("Machine, fuel, or product..."), { target: { value: "benzene" } });
    expect(document.querySelector(".mp-results")).toBeTruthy();
    expect(document.querySelectorAll(".mp-tile").length).toBeGreaterThan(0);
    expect(document.querySelector(".mp-via")?.textContent).toMatch(/^(Takes|Makes) /);
    const tile = document.querySelector(".mp-tile:not([data-source^='custom']):not([data-source^='fluid']):not([data-source^='crop'])")!;
    fireEvent.click(tile);
    expect(added.source).toHaveBeenCalledTimes(1);
  });

  it("a search nothing answers says so in the mod's words", () => {
    render(<ModPowerPicker />);
    fireEvent.change(screen.getByPlaceholderText("Machine, fuel, or product..."), { target: { value: "zzzzzz-nothing" } });
    expect(document.querySelector(".mp-none")?.textContent).toBe("No machine burns, makes or is named that.");
  });

  it("the type filter narrows to one group, and Other keeps the planning cards and the water tank", () => {
    render(<ModPowerPicker />);
    fireEvent.click(screen.getByText("All types"));
    fireEvent.click(screen.getByText("Other"));
    expect(titles()).toEqual(["OTHER"]);
    expect(document.querySelectorAll(".mp-tile")).toHaveLength(4);
  });

  it("Escape closes it", () => {
    render(<ModPowerPicker />);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useFactoryStore.getState().powerMenuOpen).toBe(false);
  });
});
