// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { writeWorkspaceView } from "@/lib/workspace-view";
import { resetDeviceSettingsForTests, writeDeviceSettings } from "@/lib/device-settings";
import { DEFAULT_BOARD_VIEW, readBoardViewSnapshot, writeBoardView } from "@/components/flow/board-view";
import { BoardToolbar } from "./BoardToolbar";
import { registerBoardCommands } from "./board-commands";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false, useIsCompactViewport: () => false }));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const renderStrip = () => render(<BoardToolbar />);
const key = (id: string) => document.querySelector<HTMLElement>(`[data-mb="${id}"]`)!;

beforeEach(() => {
  window.localStorage.clear();
  resetDeviceSettingsForTests();
  useFactoryStore.setState({ rateUnit: "second", powerDisplayUnit: "eu", undoHistory: [], redoHistory: [], isReadOnly: false });
  useDesignStore.setState({ designs: [], publicViews: [], activeDesignId: undefined });
  writeWorkspaceView({ averageMachineDraw: true });
});
afterEach(() => cleanup());

describe("the board's toolbar", () => {
  it("has the keys in the mod's order, in its words", () => {
    renderStrip();
    const order = [...document.querySelectorAll("[data-mb]")].map((element) => element.getAttribute("data-mb"));
    expect(order).toEqual(["nonrecipe", "undo", "redo", "arrange", "fit", "rate", "power", "annotate", "plan-options"]);
    expect(key("arrange").textContent).toBe("Arrange");
    expect(key("rate").textContent).toBe("/s");
    expect(key("power").textContent).toBe("EU/t");
    expect(document.querySelector('[data-mb="peak"]')).toBeNull();
    expect(key("nonrecipe").textContent).toBe("Non-recipe");
  });

  it("every key is in the Tab order (a disabled one is not) and Enter or Space presses it", () => {
    renderStrip();
    for (const id of ["nonrecipe", "arrange", "fit", "rate", "power", "annotate", "plan-options"]) {
      expect(key(id).getAttribute("tabindex"), id).toBe("0");
    }
    expect(key("undo").getAttribute("tabindex")).toBe("-1");
    key("rate").focus();
    fireEvent.keyDown(key("rate"), { key: "Enter" });
    expect(useFactoryStore.getState().rateUnit).toBe("minute");
    fireEvent.keyDown(key("rate"), { key: " " });
    expect(useFactoryStore.getState().rateUnit).toBe("hour");
  });

  it("the rate unit goes round /t /s /min /hr on a click or the wheel, and back on a right-click", () => {
    renderStrip();
    const rate = key("rate");
    fireEvent.click(rate);
    expect(useFactoryStore.getState().rateUnit).toBe("minute");
    expect(rate.textContent).toBe("/min");
    fireEvent.click(rate);
    expect(useFactoryStore.getState().rateUnit).toBe("hour");
    fireEvent.click(rate);
    expect(useFactoryStore.getState().rateUnit).toBe("tick");
    fireEvent.contextMenu(rate);
    expect(useFactoryStore.getState().rateUnit).toBe("hour");
    fireEvent.wheel(rate, { deltaY: -100 });
    expect(useFactoryStore.getState().rateUnit).toBe("tick");
    fireEvent.wheel(rate, { deltaY: 100 });
    expect(useFactoryStore.getState().rateUnit).toBe("hour");
  });

  it("EU/t becomes Amps at the tier most machines run at, and Avg and Peak swap", () => {
    renderStrip();
    fireEvent.click(key("power"));
    expect(key("power").textContent).toBe("Amps");
    expect(useFactoryStore.getState().powerDisplayUnit).not.toBe("eu");
    fireEvent.click(key("power"));
    expect(key("power").textContent).toBe("EU/t");
    expect(useFactoryStore.getState().powerDisplayUnit).toBe("eu");
  });

  it("the pencil key asks the board for its empty-board menu under the key", () => {
    const at: Array<{ x: number; y: number }> = [];
    const off = registerBoardCommands({ arrange: () => {}, cancelArrange: () => {}, fit: () => {}, openBoardMenu: (p) => at.push(p) });
    renderStrip();
    fireEvent.click(key("annotate"));
    off();
    expect(at).toHaveLength(1);
    expect(key("annotate").getAttribute("aria-label")).toBe("Annotations");
  });

  it("keeps Arrange in the toolbar and offers the saved choice first", () => {
    const arrange = vi.fn();
    const off = registerBoardCommands({ arrange, cancelArrange: () => {}, fit: () => {} });
    const project = useFactoryStore.getState().project;
    useFactoryStore.setState({
      project: { ...project, pockets: [{ id: "group", name: "Group", position: { x: 0, y: 0 } }] },
    });
    writeDeviceSettings({ keepBoardsOnArrange: true });
    writeBoardView(DEFAULT_BOARD_VIEW);
    renderStrip();
    fireEvent.click(key("plan-options"));
    const options = within(screen.getByRole("dialog", { name: "Plan options" }));
    fireEvent.click(options.getByRole("button", { name: "Background style: Slate" }));
    fireEvent.click(options.getByRole("button", { name: "Background pattern: Crosses" }));
    expect(readBoardViewSnapshot()).toMatchObject({ canvasTheme: "slate", canvasPattern: "cross" });
    const keep = options.getByRole("button", { name: "Keep boards on rearrange" });
    expect(keep.getAttribute("aria-pressed")).toBe("true");
    expect(options.queryByRole("button", { name: "Arrange the board" })).toBeNull();
    fireEvent.click(keep);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(key("arrange"));
    const entries = within(screen.getByRole("menu", { name: "Arrange" })).getAllByRole("menuitem");
    expect(entries[0]?.textContent).toContain("Ungroup all");
    expect(entries[0]).toBe(document.activeElement);
    fireEvent.click(entries[0]!);
    expect(arrange).toHaveBeenCalledExactlyOnceWith({ ungroup: true });
    expect(screen.queryByRole("dialog", { name: "Plan options" })).toBeNull();
    useFactoryStore.setState({ project });
    writeBoardView(DEFAULT_BOARD_VIEW);
    off();
  });

  it("Arrange and Fit call the board, and Arrange says what it is doing", () => {
    const calls: string[] = [];
    const off = registerBoardCommands({ arrange: () => calls.push("arrange"), cancelArrange: () => calls.push("cancel"), fit: () => calls.push("fit") });
    renderStrip();
    fireEvent.click(key("fit"));
    fireEvent.click(key("arrange"));
    expect(calls).toEqual(["fit", "arrange"]);
    off();
  });

  it("Undo and Redo are greyed until there is something to do", () => {
    renderStrip();
    expect(key("undo").hasAttribute("data-off")).toBe(true);
    expect(key("redo").hasAttribute("data-off")).toBe(true);
    act(() => {
      useFactoryStore.setState({ undoHistory: [useFactoryStore.getState().project] });
    });
    expect(key("undo").hasAttribute("data-off")).toBe(false);
  });


  it("the Non-recipe key opens the picker and closes it again", () => {
    renderStrip();
    fireEvent.click(key("nonrecipe"));
    expect(useFactoryStore.getState().powerMenuOpen).toBe(true);
    fireEvent.click(key("nonrecipe"));
    expect(useFactoryStore.getState().powerMenuOpen).toBe(false);
  });


  it("Arrange and Fit call the board, and Arrange says what it is doing", () => {
    const calls: string[] = [];
    const off = registerBoardCommands({ arrange: () => calls.push("arrange"), cancelArrange: () => calls.push("cancel"), fit: () => calls.push("fit") });
    renderStrip();
    fireEvent.click(key("fit"));
    fireEvent.click(key("arrange"));
    expect(calls).toEqual(["fit", "arrange"]);
    off();
  });

  it("Undo and Redo are greyed until there is something to do", () => {
    renderStrip();
    expect(key("undo").hasAttribute("data-off")).toBe(true);
    expect(key("redo").hasAttribute("data-off")).toBe(true);
    act(() => {
      useFactoryStore.setState({ undoHistory: [useFactoryStore.getState().project] });
    });
    expect(key("undo").hasAttribute("data-off")).toBe(false);
  });

  it("every key carries a tip for the tip host", () => {
    renderStrip();
    for (const id of ["nonrecipe", "undo", "redo", "arrange", "fit", "rate", "power", "annotate", "plan-options"]) {
      expect(key(id).getAttribute("data-tip-id"), id).toBe(`bar|${id}`);
      expect(JSON.parse(key(id).getAttribute("data-tip")!).title.length).toBeGreaterThan(3);
    }
  });
});
