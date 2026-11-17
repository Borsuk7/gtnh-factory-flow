// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { boardVirtualizer } from "./card-virtualizer";
import { CardShell, FAR_ATTRIBUTE, useVirtualPhase } from "./VirtualCard";
import type { ShellFace } from "./use-card-face";

const face: ShellFace = {
  selected: false,
  cannotRun: false,
  unset: true,
  count: "×1.5",
  countValue: 1.5,
  art: "/art.png",
  fallbackWidth: 320,
  fallbackHeight: 180,
};

/** A card the way CleanRecipeNode builds one: its contents when mounted, its shell when not. */
function Probe({ id, selected = false }: { id: string; selected?: boolean }) {
  const phase = useVirtualPhase(id, selected);
  return (
    <div className="react-flow__node" data-id={id} data-testid={`wrapper-${id}`}>
      {phase === 2 ? (
        <div data-testid={`full-${id}`}>{Array.from({ length: 48 }, (_, i) => <span key={i} />)}</div>
      ) : (
        <CardShell nodeId={id} face={face} layoutKey="k" far={phase === 0} />
      )}
    </div>
  );
}

function setup(ids: string[], drawn = true) {
  boardVirtualizer.useBoard(`board-${Math.random()}`);
  boardVirtualizer.setGeometry(ids.map((id, i) => [id, { x: i * 5000, y: 0, w: 320, h: 180 }] as const));
  if (drawn) for (const id of ids) boardVirtualizer.markDrawn(id);
  return render(
    <ReactFlowProvider>
      {ids.map((id) => (
        <Probe key={id} id={id} />
      ))}
    </ReactFlowProvider>,
  );
}

const idleMs = boardVirtualizer.config.idleMs;

afterEach(() => {
  (boardVirtualizer.config as { idleMs: number }).idleMs = idleMs;
  cleanup();
  boardVirtualizer.useBoard(undefined);
});

describe("a card's shell", () => {
  it("is two elements and wears the card's frame states and the glance face", () => {
    const { container } = setup(["a"]);
    const shell = container.querySelector("[data-shell]") as HTMLElement;
    expect(shell).not.toBeNull();
    expect(shell.querySelectorAll("*")).toHaveLength(1);
    expect(shell.className).toBe("cc-card");
    expect(shell.style.width).toBe("320px");
    expect(shell.style.height).toBe("180px");
    expect(shell.hasAttribute("data-unset")).toBe(true);
    expect(shell.hasAttribute("data-selected")).toBe(false);
    const glance = shell.querySelector(".cc-glance") as HTMLElement;
    expect(glance.getAttribute("data-count")).toBe("×1.5");
    expect(glance.getAttribute("data-node-detail")).toBe("glance");
  });
});

describe("virtualised mount", () => {
  it("mounts the contents of the cards the camera is near and leaves shells for the rest", () => {
    const ids = ["a", "b", "c", "d"];
    const { container, queryByTestId } = setup(ids);
    expect(container.querySelectorAll("[data-shell]")).toHaveLength(4);
    act(() => {
      boardVirtualizer.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
      boardVirtualizer.settle();
    });
    expect(queryByTestId("full-a")).not.toBeNull();
    expect(queryByTestId("full-b")).toBeNull();
    expect(container.querySelectorAll("[data-shell]")).toHaveLength(3);
    // The whole board is 4 shells and one 48-element card: nowhere near a card's worth for each.
    expect(container.querySelectorAll("*").length).toBeLessThan(4 + 48 + 1 + 3 * 3 + 4);
  });

  it("mounts every card while the board is held for a photograph, then lets them go", () => {
    const { container } = setup(["a", "b", "c"]);
    act(() => {
      boardVirtualizer.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
      boardVirtualizer.settle();
    });
    let release = () => {};
    act(() => {
      release = boardVirtualizer.hold();
    });
    expect(container.querySelectorAll("[data-shell]")).toHaveLength(0);
    act(() => release());
    expect(container.querySelectorAll("[data-shell]")).toHaveLength(2);
  });

  it("keeps a selected card mounted wherever the camera is", () => {
    boardVirtualizer.useBoard("sel");
    boardVirtualizer.setGeometry([["far", { x: 90_000, y: 0, w: 320, h: 180 }]]);
    const { queryByTestId } = render(
      <ReactFlowProvider>
        <Probe id="far" selected />
      </ReactFlowProvider>,
    );
    act(() => {
      boardVirtualizer.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
      boardVirtualizer.settle();
    });
    expect(queryByTestId("full-far")).not.toBeNull();
  });
});

describe("far cards", () => {
  it("hide their wrapper once drawn and far, and show it again when the camera comes", () => {
    const ids = ["a", "b"];
    // The background pass is kept out of this one: it would draw "b" as soon as the camera had rested.
    (boardVirtualizer.config as { idleMs: number }).idleMs = 1e9;
    const { getByTestId } = setup(ids, false);
    act(() => {
      boardVirtualizer.setView({ x: 0, y: 0, w: 1920, h: 1080 }, false);
      // One step now: the background pass waits for the camera to rest.
      boardVirtualizer.step(performance.now());
    });
    // Not drawn yet: shown, so that React Flow can measure it.
    expect(getByTestId("wrapper-b").hasAttribute(FAR_ATTRIBUTE)).toBe(false);
    act(() => {
      boardVirtualizer.markDrawn("b");
    });
    expect(getByTestId("wrapper-b").hasAttribute(FAR_ATTRIBUTE)).toBe(true);
    expect(getByTestId("wrapper-a").hasAttribute(FAR_ATTRIBUTE)).toBe(false);
    act(() => {
      boardVirtualizer.setView({ x: 4000, y: 0, w: 1920, h: 1080 }, false);
      boardVirtualizer.settle();
    });
    expect(getByTestId("wrapper-b").hasAttribute(FAR_ATTRIBUTE)).toBe(false);
    expect(getByTestId("full-b")).not.toBeNull();
  });
});
