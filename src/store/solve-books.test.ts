import { afterEach, expect, it, vi } from "vitest";
import type { FactoryProject } from "@/lib/model/types";
import { mockForced } from "@/lib/solver/plan/__fixtures__/mock-extras";

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

it("reuses unchanged worker readings and ignores waypoints and save stamps in the books key", async () => {
  const messages: { key: string }[] = [];
  let reply: (result: typeof mockForced.result) => void = () => {};
  vi.stubGlobal("Worker", class {
    onmessage?: (event: { data: object }) => void;
    constructor() {
      reply = (result) => this.onmessage?.({
        data: { key: messages.at(-1)!.key, result: structuredClone(result) },
      });
    }
    postMessage(request: { key: string }) {
      messages.push(request);
    }
  });
  const { registerBooksSink, solveBooks } = await import("./solve-books");
  const project = structuredClone(mockForced.project);
  const lock = { id: "lock", nodeIds: ["a", "b"], machineIds: ["a", "b"], ventNodeIds: [], edgeIds: [], vents: [] };
  const result = {
    ...mockForced.result,
    clogLocks: { locks: [lock], byNode: new Map([["a", lock], ["b", lock]]), byEdge: new Map() },
  };
  const sink = vi.fn();
  registerBooksSink(sink);
  solveBooks(project);
  reply(result);
  const first = sink.mock.calls[0]![0];
  const routed = {
    ...project,
    metadata: { ...project.metadata, updatedAt: "changed" },
    edges: project.edges.map((edge) => ({ ...edge, waypoints: [{ x: 120, y: 40 }] })),
  };
  expect(solveBooks(routed)).toBe(first);
  expect(messages).toHaveLength(1);

  const edited = { ...routed, nodes: routed.nodes.map((node) => ({ ...node, machineCount: node.machineCount + 1 })) };
  solveBooks(edited);
  expect(messages).toHaveLength(2);
  const changed = structuredClone(result);
  const id = Object.keys(changed.nodes)[0]!;
  changed.nodes[id]!.euT += 1;
  reply(changed);
  const latest = sink.mock.calls[1]![0];
  expect(latest.nodes[id]).not.toBe(first.nodes[id]);
  for (const unchangedId of Object.keys(changed.nodes).filter((key) => key !== id)) {
    expect(latest.nodes[unchangedId]).toBe(first.nodes[unchangedId]);
  }
  expect(latest.storages).toBe(first.storages);
  expect(latest.plan).toBe(first.plan);
  expect(latest.clogLocks).toBe(first.clogLocks);
});
