import { afterEach, expect, it, vi } from "vitest";
import type { FactoryProject } from "@/lib/model/types";

/**
 * Manual recalculation is gone and plan boards never showed its switch, so a
 * browser that saved it "off" must lose that value on load, or every plan it
 * opens shows the empty board's books.
 */

const RETIRED_KEY = "gtnh-factory-flow.auto-solve.v1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("removes the retired manual-recalculation setting when it loads", async () => {
  const store = new Map<string, string>([[RETIRED_KEY, "off"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.resetModules();
  await import("./solve-books");
  expect(store.has(RETIRED_KEY)).toBe(false);
});

it("loads when storage refuses access", async () => {
  vi.stubGlobal("localStorage", {
    removeItem: () => {
      throw new Error("SecurityError");
    },
  });
  vi.resetModules();
  await expect(import("./solve-books")).resolves.toHaveProperty("solveBooks");
});

it("keeps a preview response separate from the live board's pending books", async () => {
  const messages: { key: string; preview?: boolean }[] = [];
  let reply: (key: string, generatedAt: string) => void = () => {};
  vi.stubGlobal("Worker", class {
    onmessage?: (event: { data: object }) => void;
    constructor() {
      reply = (key, generatedAt) => this.onmessage?.({ data: { key, result: { generatedAt } } });
    }
    postMessage(request: { key: string; preview?: boolean }) {
      messages.push(request);
    }
  });
  const { registerBooksSink, solveBooks, solvePreview } = await import("./solve-books");
  const project: FactoryProject = {
    schemaVersion: 1, id: "preview-test", name: "Preview", recipes: [], nodes: [], edges: [],
    fuelProfiles: [], planMode: true,
  };
  const sink = vi.fn();
  registerBooksSink(sink);
  expect(solveBooks(project).stale).toBe(true);
  const preview = solvePreview({ ...project, name: "Different" });
  expect(messages[1]?.preview).toBe(true);
  reply(messages[1]!.key, "preview");
  await expect(preview).resolves.toMatchObject({ generatedAt: "preview" });
  expect(sink).not.toHaveBeenCalled();
  reply(messages[0]!.key, "board");
  expect(sink).toHaveBeenCalledExactlyOnceWith({ generatedAt: "board" });
});
