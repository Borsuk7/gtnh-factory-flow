import { EventEmitter } from "node:events";
import type { FactoryProject } from "@/lib/model/types";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({ availableParallelism: () => 4 }));
vi.mock("node:worker_threads", () => ({ Worker: TestWorker }));

class TestWorker extends EventEmitter {
  static all: TestWorker[] = [];
  readonly projects: FactoryProject[] = [];

  constructor() {
    super();
    TestWorker.all.push(this);
  }

  postMessage(project: FactoryProject) {
    this.projects.push(project);
  }

  ref() {}
  unref() {}
}

const empty: FactoryProject = {
  schemaVersion: 1, id: "plan", name: "Plan", nodes: [], recipes: [], edges: [], fuelProfiles: [],
};

afterEach(() => {
  TestWorker.all = [];
  vi.resetModules();
});

it("coalesces duplicate refreshes and dispatches queued work to idle workers", async () => {
  const { solveCommunityStats } = await import("./community-stats");
  const first = solveCommunityStats(empty, "plan:revision");
  expect(solveCommunityStats(empty, "plan:revision")).toBe(first);
  const second = solveCommunityStats({ ...empty, id: "second" });
  const third = solveCommunityStats({ ...empty, id: "third" });
  expect(TestWorker.all.map((worker) => worker.projects.map(({ id }) => id))).toEqual([["plan"], ["second"]]);

  const [left, right] = TestWorker.all;
  left!.emit("message", { stats: { machineCount: 1 } });
  expect(left!.projects.map(({ id }) => id)).toEqual(["plan", "third"]);
  right!.emit("message", { stats: { machineCount: 2 } });
  left!.emit("message", { stats: { machineCount: 3 } });
  await expect(Promise.all([first, second, third])).resolves.toEqual([
    { machineCount: 1 }, { machineCount: 2 }, { machineCount: 3 },
  ]);
  const refreshed = solveCommunityStats(empty, "plan:revision");
  expect(refreshed).not.toBe(first);
  left!.emit("message", { stats: { machineCount: 4 } });
  await expect(refreshed).resolves.toMatchObject({ machineCount: 4 });
});
