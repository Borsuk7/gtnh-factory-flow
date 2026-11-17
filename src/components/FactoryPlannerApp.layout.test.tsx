// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The board, the browser and the panels are other tests' business; here each is
// a labelled box so the test sees only WHERE the workspace seats them.
vi.mock("./flow/FactoryFlow", () => ({ FactoryFlow: () => <div data-testid="board" /> }));
vi.mock("./RecipeBrowser", () => ({
  RecipeBrowser: () => <aside data-testid="items" data-help-anchor="browser" />,
}));
vi.mock("./InspectorPanel", () => ({
  InspectorPanel: () => <aside data-testid="inspector" />,
}));
vi.mock("./AppHeader", () => ({ AppHeader: () => null }));
vi.mock("./PlanIdentityDrawer", () => ({ PlanIdentityDrawer: () => null }));
vi.mock("./TabConflictNotice", () => ({ TabConflictNotice: () => null }));
vi.mock("./library/LibraryPage", () => ({ LibraryPage: () => null }));
vi.mock("./welcome/WelcomePage", () => ({ WelcomePage: () => null }));
vi.mock("./chrome/ModPowerPicker", () => ({ ModPowerPicker: () => null }));
vi.mock("./BlueprintSaveDialog", () => ({ BlueprintSaveDialog: () => null }));

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

import { resetRailViewForTests, writeRailView } from "./flow/clean/rail/rail-view";
import { ColumnWorkspace, CompactWorkspace } from "./FactoryPlannerApp";
import { DEFAULT_WORKSPACE_VIEW, readWorkspaceViewSnapshot, writeWorkspaceView } from "@/lib/workspace-view";
import { writeDeviceSettings } from "@/lib/device-settings";
import { leaveWelcomeTab } from "@/lib/welcome/welcome-tab";
import { leaveLibrary, openLibrary } from "@/lib/library/library-tab";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

function setProject(patch: { planMode?: boolean; poolMode?: boolean }) {
  const project = useFactoryStore.getState().project;
  useFactoryStore.setState({ project: { ...project, ...patch } });
}

function renderColumns() {
  return render(<ColumnWorkspace workspace={readWorkspaceViewSnapshot()} onLoadDatasetVersion={() => {}} />);
}

/** Children of the grid in document order, by test id. */
function order(container: HTMLElement): string[] {
  const main = container.querySelector("main")!;
  return Array.from(main.children).map(
    (child) =>
      child.getAttribute("data-testid") ??
      (child.querySelector("[data-testid]")?.getAttribute("data-testid") ?? "other"),
  );
}

describe("workspace layout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetRailViewForTests();
    writeWorkspaceView({ ...DEFAULT_WORKSPACE_VIEW, leftPanelOpen: true, rightPanelOpen: true });
    leaveWelcomeTab();
    useDesignStore.setState({ isHydrated: true, activeDesignId: "d1" });
    setProject({ planMode: false, poolMode: false });
  });

  afterEach(() => {
    cleanup();
    leaveLibrary();
  });

  it("keeps the classic layout on boards that are not in plan mode", () => {
    const { container } = renderColumns();
    expect(order(container)).toEqual(["items", "board", "inspector"]);
    const main = container.querySelector("main")!;
    expect(main.getAttribute("data-items-side")).toBe("left");
    expect(main.style.gridTemplateColumns).toBe("256px minmax(0,1fr) 234px");
  });

  it("puts the overview left, the items right and no inspector in plan mode", () => {
    setProject({ planMode: true });
    const { container } = renderColumns();
    expect(order(container)).toEqual(["plan-overview", "board", "items"]);
    expect(screen.queryByTestId("inspector")).toBeNull();
    const main = container.querySelector("main")!;
    expect(main.getAttribute("data-items-side")).toBe("right");
    expect(main.style.gridTemplateColumns).toBe("336px minmax(0,1fr) 256px");
  });

  it("puts the items left and the overview right when the settings say so, each strip folding to its own side", () => {
    setProject({ planMode: true });
    act(() => writeDeviceSettings({ itemsLeft: true }));
    try {
      const { container } = renderColumns();
      expect(order(container)).toEqual(["items", "board", "plan-overview"]);
      const main = container.querySelector("main")!;
      expect(main.getAttribute("data-items-side")).toBe("left");
      expect(main.style.gridTemplateColumns).toBe("256px minmax(0,1fr) 336px");
      act(() => writeRailView({ open: false }));
      expect(screen.getByRole("button", { name: "Open the overview" }).getAttribute("data-side")).toBe("right");
    } finally {
      act(() => writeDeviceSettings({ itemsLeft: false }));
    }
  });

  it("folds the overview to a strip that survives a reload", () => {
    setProject({ planMode: true });
    const first = renderColumns();
    act(() => writeRailView({ open: false }));
    first.unmount();
    const stored = JSON.parse(window.localStorage.getItem("gtnh-factory-flow-overview-rail")!);
    expect(stored.open).toBe(false);
    const { container } = renderColumns();
    expect(container.querySelector("main")!.style.gridTemplateColumns).toBe("26px minmax(0,1fr) 256px");
    act(() => writeRailView({ open: true }));
    expect(JSON.parse(window.localStorage.getItem("gtnh-factory-flow-overview-rail")!).open).toBe(true);
  });

  it("folds the items to a 26px rail on the right, the overview's own strip", () => {
    setProject({ planMode: true });
    act(() => writeWorkspaceView({ leftPanelOpen: false }));
    act(() => writeRailView({ open: false }));
    const { container } = renderColumns();
    expect(container.querySelector("main")!.style.gridTemplateColumns).toBe("26px minmax(0,1fr) 26px");
    const rail = screen.getByRole("button", { name: "Open the items" });
    const overview = screen.getByRole("button", { name: "Open the overview" });
    // One strip for both: same class, the arrow first (at the top), the name after it.
    expect(rail.className).toBe(overview.className);
    expect(rail.getAttribute("data-side")).toBe("right");
    expect(overview.getAttribute("data-side")).toBe("left");
    expect(rail.textContent).toBe("«ITEMS");
    act(() => writeRailView({ open: true }));
    fireEvent.click(rail);
    expect(readWorkspaceViewSnapshot().leftPanelOpen).toBe(true);
  });

  it("keeps the classic columns for the Pool worksheet even in plan mode", () => {
    setProject({ planMode: true, poolMode: true });
    const { container } = renderColumns();
    expect(container.querySelector("main")!.getAttribute("data-items-side")).toBe("left");
    expect(screen.queryByTestId("plan-overview")).toBeNull();
  });

  describe("compact", () => {
    function renderCompact() {
      return render(<CompactWorkspace workspace={readWorkspaceViewSnapshot()} onLoadDatasetVersion={() => {}} />);
    }

    it("keeps items on the left and resources on the right on classic boards", () => {
      act(() => writeWorkspaceView({ leftPanelOpen: false, rightPanelOpen: false }));
      const { container } = renderCompact();
      expect(screen.getByRole("button", { name: "Show items" }).className).toContain("left-0");
      expect(screen.getByRole("button", { name: "Show resources" }).className).toContain("right-0");
      expect(container.querySelector("main")!.getAttribute("data-items-side")).toBe("left");
    });

    it("swaps the drawers in plan mode: overview left, items right", () => {
      act(() => writeWorkspaceView({ leftPanelOpen: false, rightPanelOpen: false }));
      setProject({ planMode: true });
      const { container } = renderCompact();
      expect(screen.getByRole("button", { name: "Show overview" }).className).toContain("left-0");
      expect(screen.getByRole("button", { name: "Show items" }).className).toContain("right-0");
      expect(container.querySelector("main")!.getAttribute("data-items-side")).toBe("right");
      expect(screen.queryByRole("button", { name: "Show resources" })).toBeNull();
    });

    it("opening one drawer closes the other", () => {
      act(() => writeWorkspaceView({ leftPanelOpen: false, rightPanelOpen: false }));
      setProject({ planMode: true });
      renderCompact();
      fireEvent.click(screen.getByRole("button", { name: "Show overview" }));
      expect(readWorkspaceViewSnapshot()).toMatchObject({ rightPanelOpen: true, leftPanelOpen: false });
      fireEvent.click(screen.getByRole("button", { name: "Show items" }));
      expect(readWorkspaceViewSnapshot()).toMatchObject({ rightPanelOpen: false, leftPanelOpen: true });
    });

    it("keeps the items drawer behind the library and restores it on return", () => {
      act(() => writeWorkspaceView({ leftPanelOpen: true, rightPanelOpen: false }));
      renderCompact();
      expect(screen.getByTestId("items")).toBeTruthy();
      act(() => openLibrary({ kind: "all" }));
      expect(screen.queryByTestId("items")).toBeNull();
      expect(screen.getByTestId("board")).toBeTruthy();
      act(leaveLibrary);
      expect(screen.getByTestId("items")).toBeTruthy();
    });
  });
});
