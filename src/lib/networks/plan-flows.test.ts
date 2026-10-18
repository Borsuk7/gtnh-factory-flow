import { describe, expect, it } from "vitest";
import { calculateThroughput } from "@/lib/solver";
import { drawer, node, project, recipe, wire } from "@/lib/solver/plan/adapter/test-kit";
import { planFlows } from "./plan-flows";

describe("solved plan boundaries", () => {
  it("counts collected production and external demand without counting internal machine flow", () => {
    const input = project({
      recipes: [
        recipe("make", [["ore", 2]], [["intermediate", 1]]),
        recipe("finish", [["intermediate", 1]], [["product", 1]]),
      ],
      nodes: [node("a", "make", { solvePin: 1, solvePinExact: true }), node("b", "finish")],
      storages: [
        drawer("in", "ore"),
        drawer("out", "product", { targetPerSecond: 1, targetMode: "exact" }),
      ],
      edges: [
        wire("in", "in", "a", "ore", {}, { fromDrawer: true }),
        wire("middle", "a", "b", "intermediate"),
        wire("out", "b", "out", "product", {}, { toDrawer: true }),
      ],
    });
    const result = planFlows(input, calculateThroughput(input));
    expect(result.error).toBeUndefined();
    expect(result.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "item:ore", supply: 0, demand: 2 }),
        expect.objectContaining({ key: "item:product", supply: 1, demand: 0 }),
      ]),
    );
    expect(result.materials.find((entry) => entry.resourceId === "intermediate")).toBeUndefined();
    expect(result.power.used).toBe(60);
  });

  it("does not offer trashed byproducts as network supply", () => {
    const input = project({
      recipes: [
        recipe(
          "make",
          [],
          [
            ["product", 1],
            ["waste", 3],
          ],
        ),
      ],
      nodes: [node("a", "make", { solvePin: 1, solvePinExact: true })],
      storages: [
        drawer("out", "product", { targetPerSecond: 1, targetMode: "exact" }),
        drawer("trash", "waste", { drainMode: "trash" }),
      ],
      edges: [
        wire("out", "a", "out", "product", {}, { toDrawer: true }),
        wire("trash", "a", "trash", "waste", {}, { toDrawer: true }),
      ],
    });
    const result = planFlows(input, calculateThroughput(input));
    expect(result.materials).toEqual([
      expect.objectContaining({ resourceId: "product", supply: 1 }),
    ]);
  });
});
