// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNetworkStore } from "@/store/network-store";
import { leaveLibrary, readLibraryTabState } from "@/lib/library/library-tab";
import { NetworkPage } from "./NetworkPage";

vi.mock("@/lib/networks/calculation", () => ({
  useNetworkCalculations: () => new Map(),
  localDesignId: (member: { designId: string }) => member.designId,
}));

afterEach(cleanup);

it("returns from an open network to the Networks library", () => {
  leaveLibrary();
  useNetworkStore.setState({
    activeId: "main",
    catalogue: {
      account: "local",
      token: "t",
      revision: 0,
      dirty: false,
      networks: [{ id: "main", name: "Main", included: true, members: [], sharing: {} }],
    },
  });
  render(<NetworkPage />);
  fireEvent.click(screen.getByRole("button", { name: "Back to networks" }));
  expect(useNetworkStore.getState().activeId).toBeUndefined();
  expect(readLibraryTabState()).toEqual({ active: true, view: { kind: "networks" } });
  expect(screen.getByRole("heading", { name: "Networks" })).toBeTruthy();
});
