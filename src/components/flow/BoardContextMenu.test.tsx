// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BoardContextMenu } from "./BoardContextMenu";

afterEach(() => cleanup());

const target = { kind: "pane" as const, x: 10, y: 10, flow: { x: 300, y: 200 } };

describe("the empty-board menu", () => {
  it("only offers a new product drawer and opens its resource picker", () => {
    render(<BoardContextMenu target={target} onClose={() => {}} />);
    const menu = within(screen.getByRole("menu", { name: "Board menu" }));
    const drawer = menu.getByRole("menuitem", { name: "New product drawer" });
    expect(menu.getAllByRole("menuitem")).toEqual([drawer]);
    fireEvent.click(drawer);
    expect(screen.queryByRole("menu", { name: "Board menu" })).toBeNull();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});
