/** The island cache (spec-solver 4.4): an edit re-solves only the islands it touched. Work is counted (LPs), never timed. */
import { beforeAll, describe, expect, it } from "vitest";

import { initLpEngine } from "../lp-engine";
import { differences } from "./__fixtures__/compare";
import { digest } from "./__fixtures__/digest";
import { loadInput, tile } from "./__fixtures__/load";
import { IslandCache, inputDigest, type PieceCache } from "./cache";
import { takeLpCount } from "./lp";
import { islandCache } from "./adapter/engine";
import { splitIslands } from "./islands";
import { planExtensions, solvePlan } from "./solve-plan";
import type { Answer, SolveInput } from "./types";

beforeAll(async () => {
  await initLpEngine();
});

/** Solves and returns the answer with the LPs it ran. */
function counted(input: SolveInput, cache?: PieceCache): { answer: Answer; lps: number } {
  takeLpCount();
  const answer = solvePlan(input, planExtensions, cache);
  return { answer, lps: takeLpCount() };
}

describe("inputDigest", () => {
  it("is the same for equal inputs whatever order a record was filled in", () => {
    const a = loadInput("gtnh-flow-mk1");
    const b: SolveInput = JSON.parse(JSON.stringify(a));
    a.spares = { k: { x: 1, y: 2 } };
    b.spares = { k: { y: 2, x: 1 } };
    expect(inputDigest(a)).toBe(inputDigest(b));
    b.machines[0]!.machineCount += 1;
    expect(inputDigest(a)).not.toBe(inputDigest(b));
  });
});

describe("IslandCache", () => {
  it("drops the least recently used first and counts hits", () => {
    const cache = new IslandCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // a is now the newest
    cache.set("c", 3); // b goes
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect([cache.hits, cache.misses]).toEqual([3, 1]);
  });
});

describe("solvePlan with a cache", () => {
  const COPIES = 5;
  const alone = loadInput("hv-diesel");
  const big = () => tile(alone, COPIES);

  it("the same input again runs no LP and answers the same", () => {
    const cache = new IslandCache<never>(64) as unknown as PieceCache;
    const first = counted(big(), cache);
    expect(first.lps).toBeGreaterThan(0);
    const again = counted(big(), cache);
    expect(again.lps).toBe(0);
    expect(differences(digest(first.answer), digest(again.answer))).toEqual([]);
  });

  it("editing one island re-solves that island only; the others run no LP", () => {
    const cache = new IslandCache<never>(64) as unknown as PieceCache;
    const input = big();
    const base = counted(input, cache);
    const islands = splitIslands(input).length;
    expect(islands).toBeGreaterThanOrEqual(COPIES);

    // Change one pinned machine of the third copy.
    const n = alone.machines.length;
    const edited: SolveInput = JSON.parse(JSON.stringify(input));
    const pinned = edited.machines.slice(2 * n, 3 * n).find((m) => m.countFixed)!;
    pinned.machineCount += 1;
    const touched = splitIslands(edited).find((island) => island.machines.some((m) => m.id === pinned.id))!;
    const hitsBefore = cache.hits;
    const after = counted(edited, cache);
    expect(cache.hits - hitsBefore).toBe(islands - 1); // every island but the edited one is read back
    expect(after.lps).toBe(counted(touched).lps); // the edited island's own work, none of the others'
    expect(after.lps).toBeGreaterThan(0);
    expect(after.lps).toBeLessThan(base.lps / 2);

    // Exactly what a cold solve of the edited plan says.
    const cold = counted(edited);
    expect(cold.lps).toBe(base.lps);
    expect(differences(digest(cold.answer), digest(after.answer))).toEqual([]);

    // Undo finds the older answer.
    expect(counted(input, cache).lps).toBe(0);
  });

  it("the adapter's engine keeps one", () => {
    islandCache.clear();
    expect(counted(loadInput("hv-diesel"), islandCache).lps).toBeGreaterThan(0);
    expect(counted(loadInput("hv-diesel"), islandCache).lps).toBe(0);
    islandCache.clear();
  });

  it("reads the retained islands before misses can evict them", () => {
    const input: SolveInput = {
      mode: "AUTO", edges: [], pools: [], drawers: [], extentPins: {}, choice: null, spares: {},
      machines: Array.from({ length: 65 }, (_, index) => ({
        id: `m${index}`, name: `M${index}`, countFixed: true, machineCount: 1,
        durationTicks: 20, energyPerTick: 0, throughputFactor: 1, inputs: [], outputs: [],
        targetOutputRates: {}, targetInputRates: {},
      })),
    };
    const cache = new IslandCache<never>(64) as unknown as PieceCache;
    const first = counted(input, cache);
    const hits = cache.hits;
    const second = counted(input, cache);
    expect(cache.hits - hits).toBe(64);
    expect(differences(digest(first.answer), digest(second.answer))).toEqual([]);

    const edited = structuredClone(input);
    edited.machines.at(-1)!.machineCount += 1;
    const beforeEdit = cache.hits;
    const afterEdit = counted(edited, cache);
    expect(cache.hits - beforeEdit).toBeGreaterThanOrEqual(63);
    expect(differences(digest(counted(edited).answer), digest(afterEdit.answer))).toEqual([]);
  });
});
