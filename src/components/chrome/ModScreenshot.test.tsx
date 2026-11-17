// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  embedProjectJsonInPng,
  embedProjectJsonInPngMetadata,
  FLOW_IMAGE_EXPORT_COMPLETE_EVENT,
  FLOW_IMAGE_EXPORT_EVENT,
  type FlowExportRequest,
} from "@/lib/import-export/plan-image";
import { useDesignStore } from "@/store/design-store";
import { ModScreenshot } from "./ModScreenshot";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false }));
vi.mock("@/lib/import-export/plan-image", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/import-export/plan-image")>(),
  embedProjectJsonInPng: vi.fn(async (blob: Blob) => blob),
  embedProjectJsonInPngMetadata: vi.fn(async (blob: Blob) => blob),
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
  // jsdom has no layout: the well measures as the mod's (1200 x 720 box less its column).
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
});

const asked: Array<Pick<FlowExportRequest, "format" | "cardDetail" | "hideAnnotations" | "background" | "animateWires">> = [];
const onExport = (event: Event) => {
  const { requestId, format, cardDetail, hideAnnotations, background, animateWires } = (event as CustomEvent<FlowExportRequest>).detail;
  asked.push({ format, cardDetail, hideAnnotations, background, animateWires });
  queueMicrotask(() =>
    window.dispatchEvent(
      new CustomEvent(FLOW_IMAGE_EXPORT_COMPLETE_EVENT, {
        detail: {
          requestId,
          capture: {
            kind: format,
            ...(format === "svg"
              ? { svgText: '<svg xmlns="http://www.w3.org/2000/svg" width="1260" height="628"/>' }
              : { blob: new Blob(["x"], { type: "image/png" }) }),
            width: 1260,
            height: 628,
            pixelRatio: 2,
            viewport: { x: 0, y: 0, zoom: 1 },
            occlusionRects: [],
          },
        },
      }),
    ),
  );
};

beforeEach(() => {
  asked.length = 0;
  vi.clearAllMocks();
  useDesignStore.setState({ designs: [], activeDesignId: undefined });
  window.addEventListener(FLOW_IMAGE_EXPORT_EVENT, onExport);
});
afterEach(() => {
  window.removeEventListener(FLOW_IMAGE_EXPORT_EVENT, onExport);
  cleanup();
});

describe("the screenshot box", () => {
  it("shows the picture as it will come out, its size in pixels, and the mod's choices: Cards, Plan name, Inputs and outputs", async () => {
    render(<ModScreenshot onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Screenshot" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".mshot-size")?.textContent).toBe("2,520 x 1,256 pixels"));
    expect(asked[0]).toMatchObject({ format: "png", cardDetail: "full", hideAnnotations: false, animateWires: false });
    expect([...document.querySelectorAll('[aria-label="Cards"] .ms-choice')].map((element) => element.textContent)).toEqual(["Detailed", "Simple"]);
    expect(screen.getByRole("switch", { name: "Plan name" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Inputs and outputs" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Transparent background" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Show annotations" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Embed plan" }).getAttribute("aria-checked")).toBe("true");
    // By default it is the plan and nothing else, with the mark every picture carries.
    expect(document.querySelector(".mshot-mark")?.textContent).toBe("GTNH Planner");
  });

  it("Simple takes the zoomed-out look and the picture is taken again", async () => {
    render(<ModScreenshot onClose={vi.fn()} />);
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByText("Simple"));
    });
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1].cardDetail).toBe("glance");
  });

  it("Copy and Save wait for the picture, and Escape closes the box", async () => {
    const onClose = vi.fn();
    render(<ModScreenshot onClose={onClose} />);
    await waitFor(() => expect(document.querySelector('.mshot-key[data-save]')?.hasAttribute("data-off")).toBe(false));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("captures the requested pixels and embeds the plan only when selected", async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<ModScreenshot onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("switch", { name: "Transparent background" }));
      fireEvent.click(screen.getByRole("switch", { name: "Show annotations" }));
      const save = screen.getByRole("button", { name: "Save" });
      await waitFor(() => expect(save.getAttribute("aria-disabled")).toBe("false"));
      expect(asked.at(-1)).toMatchObject({ background: "transparent", hideAnnotations: true });
      expect(screen.getByText("The embedded plan includes annotations.")).toBeTruthy();
      expect(screen.getByText("Use Save to embed the plan in a transparent PNG.")).toBeTruthy();

      fireEvent.click(save);
      await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
      expect(embedProjectJsonInPngMetadata).toHaveBeenCalledTimes(1);
      expect(embedProjectJsonInPng).not.toHaveBeenCalled();

      const captureCount = asked.length;
      fireEvent.click(screen.getByRole("switch", { name: "Embed plan" }));
      fireEvent.click(save);
      await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
      expect(embedProjectJsonInPngMetadata).toHaveBeenCalledTimes(1);
      expect(embedProjectJsonInPng).not.toHaveBeenCalled();
      expect(asked).toHaveLength(captureCount);
    } finally {
      download.mockRestore();
    }
  });

  it("saves an SVG capture and requests flowing wires only for GIF", async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<ModScreenshot onClose={vi.fn()} />);
      const save = screen.getByRole("button", { name: "Save" });
      await waitFor(() => expect(save.getAttribute("aria-disabled")).toBe("false"));
      fireEvent.click(screen.getByRole("radio", { name: "SVG" }));
      fireEvent.click(save);
      await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
      expect((download.mock.instances[0] as HTMLAnchorElement).download).toMatch(/\.svg$/);
      expect(asked.at(-1)).toMatchObject({ format: "svg", animateWires: false });

      fireEvent.click(screen.getByRole("radio", { name: "GIF" }));
      expect(screen.queryByRole("switch", { name: "Embed plan" })).toBeNull();
      await waitFor(() => expect(asked.at(-1)).toMatchObject({ format: "png", animateWires: true }));
    } finally {
      download.mockRestore();
    }
  });
});
