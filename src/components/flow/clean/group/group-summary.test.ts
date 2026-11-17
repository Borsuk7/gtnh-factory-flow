import { describe, expect, it } from "vitest";
import { mockUnneeded } from "@/lib/solver/plan/__fixtures__/mock-extras";
import { computeGroupSummaries } from "./group-summary";

describe("a group summary's machines", () => {
  const withPocket = () => {
    const project = structuredClone(mockUnneeded.project);
    project.pockets = [{ id: "g", name: "G" }] as typeof project.pockets;
    project.nodes.find((n) => n.id === "comp")!.pocketId = "g";
    return project;
  };

  it("counts what an Up to card runs, rounded up", () => {
    const plan = {
      ...mockUnneeded.result.plan!,
      upTo: { comp: { capacity: 6, reached: 4.5, reason: null } },
    };
    const sum = computeGroupSummaries(withPocket(), { ...mockUnneeded.result, plan }, ["g"], true);
    expect(sum.get("g")!.machines).toBe(5);
  });

  it("counts an Exactly card at its set count", () => {
    const project = withPocket();
    project.nodes.find((n) => n.id === "comp")!.solvePinExact = true;
    const plan = {
      ...mockUnneeded.result.plan!,
      upTo: { comp: { capacity: 6, reached: 4.5, reason: null } },
    };
    const sum = computeGroupSummaries(project, { ...mockUnneeded.result, plan }, ["g"], true);
    expect(sum.get("g")!.machines).toBe(6);
  });

  it("rolls nested flows up and only returns detail for the requested collapsed group", () => {
    const project = withPocket();
    project.pockets = [
      { id: "parent", name: "Parent", position: { x: 0, y: 0 } },
      { id: "g", name: "Child", parentPocketId: "parent", position: { x: 0, y: 0 } },
    ];
    const all = computeGroupSummaries(project, mockUnneeded.result, ["parent", "g"], true);
    expect(all.get("parent")).toEqual(all.get("g"));
    const counts = computeGroupSummaries(project, mockUnneeded.result, ["parent", "g"], true, new Set(["parent"]));
    expect(counts.get("parent")).toEqual(all.get("parent"));
    expect(counts.get("g")).toMatchObject({ machines: all.get("g")!.machines, inputs: [], outputs: [] });
  });
});
