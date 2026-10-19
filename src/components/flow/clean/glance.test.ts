import { describe, expect, it } from "vitest";
import { glanceBar, glanceFace } from "./glance";

describe("the zoomed-out bar", () => {
  it("fills to what runs over the count, in the reason's tone with its word", () => {
    expect(glanceBar({ capacity: 24, reached: 18, reason: "STARVED" })).toEqual({
      tone: "starved",
      fill: 0.75,
      word: "STARVED",
    });
    // A bottleneck's runs to what the line wants, as the card's own bar.
    expect(glanceBar({ capacity: 24, reached: 24, reason: "BOTTLENECK", wants: 32 })).toEqual({
      tone: "bottleneck",
      fill: 0.75,
      word: "BOTTLENECK",
    });
    expect(glanceBar({ capacity: 6, reached: 3, reason: null })).toEqual({
      tone: "plain",
      fill: 0.5,
      word: "",
    });
    expect(glanceBar({ capacity: 0, reached: 0, reason: "UNUSED" })!.fill).toBe(0);
    expect(glanceBar(undefined)).toBeUndefined();
  });

  it("says a ring's name in its tone on a card in a ring", () => {
    expect(glanceBar({ capacity: 2, reached: 0, reason: "STARVED" }, "dead")).toEqual({
      tone: "starved",
      fill: 0,
      word: "DEAD LOOP",
    });
    expect(glanceBar({ capacity: 2, reached: 0, reason: "UNUSED" }, "clog")).toEqual({
      tone: "clogged",
      fill: 0,
      word: "CLOG LOCK",
    });
  });

  it("is two background layers over the picture, the word the layer's own text", () => {
    const face = glanceFace("url(/art.png)", { tone: "clogged", fill: 0.5, word: "CLOGGED" });
    expect(face["data-bar"]).toBe("");
    expect(face["data-tone"]).toBe("clogged");
    expect(face.text).toBe("CLOGGED");
    const style = face.style as Record<string, string>;
    expect(style["--glance-fill"]).toBe("50%");
    // The picture stays a url the minimap can read back.
    expect(style.backgroundImage.split(", ").at(-1)).toBe("url(/art.png)");
    expect(glanceFace("url(/art.png)", undefined)).toEqual({
      style: { backgroundImage: "url(/art.png)" },
      text: "",
    });
    expect(glanceFace(undefined, undefined).style).toBeUndefined();
  });

  it("carries a structure render's width over height, so a tall card keeps it whole", () => {
    const bar = { tone: "clogged" as const, fill: 0.5, word: "CLOGGED" };
    const reactor = glanceFace("url(/power-art/large-chemical-reactor.png)", bar).style as Record<
      string,
      string
    >;
    expect(Number(reactor["--glance-art-ratio"])).toBeCloseTo(4 / 3, 2);
    // An icon is square: the stylesheet's default.
    const icon = glanceFace("url(/icons/x.png)", bar).style as Record<string, string>;
    expect(icon["--glance-art-ratio"]).toBeUndefined();
  });
});
