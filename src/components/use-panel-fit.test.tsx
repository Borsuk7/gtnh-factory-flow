// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestPanelOpen } from "@/lib/panel-force";
import { BOARD_MIN_WIDTH } from "@/lib/workspace-columns";
import { usePanelFit, type PanelFitState, type PanelWishes } from "./use-panel-fit";

const WISHES: PanelWishes = {
  itemsOpen: true,
  overviewOpen: true,
  itemsWidth: 256,
  overviewWidth: 336,
  covering: false,
  itemsLeft: false,
};

let width = 0;
const watchers = new Set<() => void>();
let latest: PanelFitState;

function Harness({ wishes = WISHES, enabled = true }: { wishes?: PanelWishes; enabled?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  latest = usePanelFit(ref, wishes, enabled);
  return <main ref={ref} data-testid="main" style={{ gridTemplateColumns: latest.initial.template }} />;
}

const main = () => document.querySelector<HTMLElement>("[data-testid='main']")!;
const template = () => main().style.gridTemplateColumns;
const resize = (next: number) => {
  width = next;
  act(() => {
    for (const callback of [...watchers]) callback();
  });
};
const shown = () => `${latest.itemsOpen ? "I" : "i"}${latest.overviewOpen ? "O" : "o"}`;

beforeEach(() => {
  width = 1641;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        watchers.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        watchers.delete(this.callback);
      }
    },
  );
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("data-testid") === "main" ? width : 0;
  });
});
afterEach(() => {
  cleanup();
  watchers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePanelFit", () => {
  it("writes the player's widths onto the grid while the window has room, and what the overlays read with them", () => {
    render(<Harness />);
    expect(template()).toBe("336px minmax(0,1fr) 256px");
    expect([main().dataset.leftPx, main().dataset.rightPx]).toEqual(["336", "256"]);
    expect(shown()).toBe("IO");
  });

  it("follows a wider or narrower setting", () => {
    const view = render(<Harness />);
    view.rerender(<Harness wishes={{ ...WISHES, itemsWidth: 180, overviewWidth: 400 }} />);
    expect(template()).toBe("400px minmax(0,1fr) 180px");
  });

  it("the columns shrink toward their least, then the items list folds, then the overview, as the window narrows", () => {
    render(<Harness />);
    const seen: string[] = [];
    for (let at = 1641; at >= 500; at -= 10) {
      resize(at);
      seen.push(shown());
    }
    expect(seen.filter((value, index) => index === 0 || value !== seen[index - 1])).toEqual(["IO", "iO", "io"]);
  });

  it("at Large on a 1280 window the items list is a strip and the board keeps its least", () => {
    render(<Harness />);
    resize(842);
    expect(shown()).toBe("iO");
    expect(latest.itemsAutoFolded).toBe(true);
    const [left, , right] = template().split(" ");
    expect(right).toBe("26px");
    expect(842 - Number.parseInt(left) - 26).toBeGreaterThanOrEqual(BOARD_MIN_WIDTH);
  });

  it("a column folds back when the window widens, and the player's own fold is never written", () => {
    render(<Harness />);
    resize(842);
    expect(shown()).toBe("iO");
    resize(1641);
    expect(shown()).toBe("IO");
  });

  it("a column the player folded stays folded at any width", () => {
    render(<Harness wishes={{ ...WISHES, itemsOpen: false }} />);
    for (const at of [1641, 842, 600]) {
      resize(at);
      expect(latest.itemsOpen).toBe(false);
      expect(latest.itemsAutoFolded).toBe(false);
    }
  });

  it("asked to open a column the window folded, it stays open and the overview gives way", () => {
    render(<Harness />);
    resize(842);
    expect(shown()).toBe("iO");
    act(() => requestPanelOpen("items"));
    expect(shown()).toBe("Io");
    expect(template().endsWith(" 108px") || Number.parseInt(template().split(" ")[2]) >= 108).toBe(true);
    // The window widens: nothing folds it now, so the request is let go.
    resize(1641);
    expect(shown()).toBe("IO");
    resize(842);
    expect(shown()).toBe("iO");
  });

  it("the overview opened against the window stays and the items list folds, as it would", () => {
    render(<Harness wishes={{ ...WISHES, overviewOpen: true }} />);
    resize(700);
    expect(shown()).toBe("io");
    act(() => requestPanelOpen("overview"));
    expect(shown()).toBe("iO");
  });

  it("a request for a column the player has folded changes nothing until they open it", () => {
    const view = render(<Harness wishes={{ ...WISHES, itemsOpen: false }} />);
    resize(842);
    act(() => requestPanelOpen("items"));
    expect(latest.itemsOpen).toBe(false);
    // The player's open and the request arrive together (the strip's click).
    view.rerender(<Harness wishes={{ ...WISHES, itemsOpen: true }} />);
    expect(shown()).toBe("Io");
  });

  it("a drag shows the width straight on the grid without re-rendering, and the end puts the fit back", () => {
    render(<Harness />);
    const before = latest;
    act(() => {
      latest.setResizing(true);
      latest.preview("items", 300);
    });
    expect(template()).toBe("336px minmax(0,1fr) 300px");
    expect(main().dataset.rightPx).toBe("300");
    // A resize in the middle of a drag does not fight it.
    resize(1700);
    expect(template()).toBe("336px minmax(0,1fr) 300px");
    act(() => latest.setResizing(false));
    expect(template()).toBe("336px minmax(0,1fr) 256px");
    expect(latest.itemsOpen).toBe(before.itemsOpen);
  });

  it("reports the column's width and what it can be dragged to", () => {
    render(<Harness />);
    expect(latest.widthOf("items")).toBe(256);
    expect(latest.widthOf("overview")).toBe(336);
    expect(latest.limitsOf("items")).toEqual({ min: 108, max: 420 });
    resize(1000);
    expect(latest.limitsOf("overview").max).toBe(1000 - BOARD_MIN_WIDTH - latest.widthOf("items"));
  });

  it("under a covering page the overview is gone, not folded", () => {
    render(<Harness wishes={{ ...WISHES, covering: true }} />);
    expect(template()).toBe("0px minmax(0,1fr) 256px");
    expect(latest.overviewOpen).toBe(false);
    expect(latest.overviewAutoFolded).toBe(false);
  });

  it("the other way round (Settings, Item browser): the items list on the left", () => {
    render(<Harness wishes={{ ...WISHES, itemsLeft: true }} />);
    expect(template()).toBe("256px minmax(0,1fr) 336px");
  });

  it("does nothing for a classic board", () => {
    render(<Harness enabled={false} />);
    resize(842);
    expect(main().dataset.leftPx).toBeUndefined();
    expect(shown()).toBe("IO");
  });
});
