// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CleanCardView, CleanPortView } from "../clean-model";
import { forcedTip, nameTip, openBoxTip, openKeyTip, portTip, tierTip } from "./tips";
import { readTip, splitGold, tipAttrs } from "./tip-spec";

function port(over: Partial<CleanPortView> = {}): CleanPortView {
  return {
    key: "k",
    nodeId: "n1",
    handleId: "input:item:iron",
    side: "input",
    port: { resource: { alternatives: [] } } as unknown as CleanPortView["port"],
    number: "12",
    perSecond: 12,
    unit: "/s",
    name: "Iron Ingot",
    title: "Iron Ingot",
    zero: false,
    gold: false,
    numberSmall: false,
    nameSmall: false,
    nameClipped: false,
    wired: false,
    choice: false,
    resourceKey: "item:iron",
    ...over,
  };
}

describe("tip data on an element", () => {
  it("round-trips through the attribute and keeps the identity for the rest wait", () => {
    const spec = portTip(port());
    const el = document.createElement("div");
    for (const [name, value] of Object.entries(tipAttrs(spec))) el.setAttribute(name, value);
    expect(el.getAttribute("data-tip-id")).toBe("n1|port|input:item:iron");
    expect(readTip(el)).toEqual(spec);
  });

  it("reads nothing from a broken attribute", () => {
    const el = document.createElement("div");
    el.setAttribute("data-tip", "{nope");
    expect(readTip(el)).toBeUndefined();
    expect(readTip(document.createElement("div"))).toBeUndefined();
  });

  it("splits gold words between asterisks", () => {
    expect(splitGold("a *b* c")).toEqual([
      { text: "a ", gold: false },
      { text: "b", gold: true },
      { text: " c", gold: false },
    ]);
  });
});

describe("the card's tip wording", () => {
  it("port: consumed or produced, with the browse actions and the key line", () => {
    const tip = portTip(port());
    expect(tip.title).toBe("Iron Ingot");
    expect(tip.sub).toBe("Input");
    expect(tip.rows).toEqual([{ label: "Consumed", value: "12 /s" }]);
    expect(tip.actions?.map((a) => a.label)).toEqual(["Recipes: what makes it", "Uses: what uses it", "Connect", "R, U"]);
    expect(portTip(port({ side: "output" })).rows?.[0]?.label).toBe("Produced");
  });

  it("port: a chance row for chanced outputs and the choice note and wheel action", () => {
    const chanced = portTip(
      port({ side: "output", port: { resource: { chance: 0.25 } } as unknown as CleanPortView["port"] }),
    );
    expect(chanced.rows?.[1]).toEqual({ label: "Chance", value: "25%" });
    const choice = portTip(
      port({ choice: true, port: { resource: { alternatives: [1, 2, 3] } } as unknown as CleanPortView["port"] }),
    );
    expect(choice.notes?.[0]?.text).toBe("Takes any of 3 items.");
    expect(choice.actions?.some((a) => a.input === "wheel" && a.label === "Change item")).toBe(true);
  });

  it("open port key: Any then Exactly, with the click it takes", () => {
    const any = openKeyTip(port(), false);
    expect(any.title).toBe("Any");
    expect(any.actions).toEqual([{ input: "left", label: "Set it to what it is now" }]);
    const exact = openKeyTip(port(), true);
    expect(exact.title).toBe("Exactly");
    expect(exact.notes?.[0]?.text).toContain("takes exactly its rate");
    expect(exact.actions?.[0]?.label).toBe("Let the plan decide");
  });

  it("open port box: rate decided by the plan or set", () => {
    expect(openBoxTip(port(), false).sub).toBe("Rate: the plan decides");
    expect(openBoxTip(port(), true).sub).toBe("Rate set");
    expect(openBoxTip(port({ side: "output" }), false).rows?.[0]?.label).toBe("Gives");
    expect(openBoxTip(port(), true).actions?.[0]?.label).toBe("Change its rate");
  });

  it("forced row: ships out or comes in", () => {
    const out = forcedTip(port({ side: "output", forced: { number: "3", unit: "/s", perSecond: 3 } }));
    expect(out.title).toBe("Forced output: Iron Ingot");
    expect(out.rows?.[0]).toEqual({ label: "Ships out here", value: "3 /s" });
    expect(forcedTip(port({ forced: { number: "3", unit: "/s", perSecond: 3 } })).rows?.[0]?.label).toBe("Comes in here");
  });

  const view = {
    nodeId: "n1",
    name: "Electric Blast Furnace",
    hasPicker: true,
    tier: { label: "LV", fixed: false, title: "" },
    count: { text: "×3", pinned: true, zero: false, note: "(pinned)", value: 3, title: "" },
    power: { number: "TIER!", unit: "", name: "Power", stalled: true, title: "" },
  } as unknown as CleanCardView;

  it("name: pinned machines, its tier, the picker actions", () => {
    const tip = nameTip(view);
    expect(tip.rows).toEqual([
      { label: "Pinned machines", value: "x3" },
      { label: "Configured tier", value: "LV" },
    ]);
    expect(tip.actions?.map((a) => a.label)).toEqual(["Machines that run it", "Next machine"]);
  });

  it("tier: steps, and says so in red when it cannot run", () => {
    const tip = tierTip(view);
    expect(tip.title).toBe("Voltage tier");
    expect(tip.notes?.[0]).toEqual({ text: "Below the recipe's tier: it cannot run.", tone: "red" });
    expect(tip.actions?.map((a) => a.label)).toEqual(["Up", "Down", "Step"]);
    expect(tierTip({ ...view, tier: { label: "LuV", fixed: true, title: "" } } as CleanCardView).actions).toEqual([]);
  });
});
