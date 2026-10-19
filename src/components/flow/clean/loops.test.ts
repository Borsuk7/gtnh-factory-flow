import { describe, expect, it } from "vitest";
import { mockLoops } from "@/lib/solver/plan/__fixtures__/mock-extras";
import { makePortKey } from "@/lib/solver/plan/port-key";
import { buildNotices } from "./rail/notices";
import { cardLoop, loopEdges, loopSentence, loopTag, loopTone } from "./loops";

const loops = mockLoops.result.plan!.loops!;

describe("a ring on the board", () => {
  it("tones a dead loop as STARVED's and a clog lock as CLOGGED's", () => {
    expect(loops.map(loopTone)).toEqual(["dead", "clog"]);
    expect(cardLoop(loops, "rb")).toBe("dead");
    expect(cardLoop(loops, "make")).toBe("clog");
    expect(cardLoop(loops, "nobody")).toBeUndefined();
    expect(cardLoop(undefined, "rb")).toBeUndefined();
  });

  it("lights the wires that join its cards along its rows, and no others", () => {
    const lit = loopEdges(mockLoops.project.edges, loops);
    expect(Object.fromEntries(lit)).toEqual({
      "w-ab": "dead",
      "w-bc": "dead",
      "w-ca": "dead",
      // The clog lock's cards are stuck on hydrogen and on water: those wires, not its oxygen.
      "w-h": "clog",
      "w-w": "clog",
    });
    expect(loopEdges(mockLoops.project.edges, undefined).size).toBe(0);
  });

  it("finds a shared machine's recipe row by its section", () => {
    const edges = [
      {
        id: "e",
        source: "a",
        target: "b",
        sourceHandle: "output:item:x",
        targetHandle: "r1:input:item:x",
      },
    ];
    const ring = [
      {
        kind: "DEAD_LOOP" as const,
        cards: ["a", "b"],
        portKeys: [makePortKey("b#r1", "i", "input:item:x")],
        resourceKeys: ["item:x"],
      },
    ];
    expect(loopEdges(edges, ring).get("e")).toBe("dead");
  });
});

describe("a ring's notice", () => {
  it("names what it is and says it is a downward spiral, in one short sentence", () => {
    const dead = { kind: "DEAD_LOOP" as const };
    const clog = { kind: "CLOG_LOCK" as const };
    expect(loopTag(dead)).toBe("DEAD LOOP");
    expect(loopTag(clog)).toBe("CLOG LOCK");
    expect(loopSentence(dead, 3)).toBe("These machines starve each other in a downward spiral.");
    expect(loopSentence(clog, 2)).toBe("These machines clog each other in a downward spiral.");
    expect(loopSentence(dead, 1)).toBe("This machine starves itself in a downward spiral.");
    expect(loopSentence(clog, 1)).toBe("This machine clogs itself in a downward spiral.");
  });

  it("is an alarm in the notice bar once per ring, with Show me on its cards", () => {
    const notices = buildNotices(mockLoops.project, mockLoops.result).filter((n) =>
      n.id.startsWith("loop:"),
    );
    expect(notices.map((n) => [n.severity, n.tag, n.loop, n.text, n.focus])).toEqual([
      [
        "error",
        "DEAD LOOP",
        "dead",
        "These machines starve each other in a downward spiral.",
        ["ra", "rb", "rc"],
      ],
      [
        "error",
        "CLOG LOCK",
        "clog",
        "These machines clog each other in a downward spiral.",
        ["split", "make"],
      ],
    ]);
  });
});
