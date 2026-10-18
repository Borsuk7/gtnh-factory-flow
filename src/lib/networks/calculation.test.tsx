// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { useNetworkStore } from "@/store/network-store";
import { readDesign } from "@/lib/designs/design-storage";
import { project, recipe } from "@/lib/solver/plan/adapter/test-kit";
import { memberKey, type PlanFlows } from "./model";
import { useNetworkCalculations } from "./calculation";

vi.mock("@/lib/designs/design-storage", async (original) => ({
  ...(await original<typeof import("@/lib/designs/design-storage")>()),
  readDesign: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

describe("closed network member calculations", () => {
  it("caches unchanged plans, ignores display dials, marks changed figures stale, and exposes unavailable members", async () => {
    const posted = vi.fn();
    let deliver!: (result: PlanFlows) => void;
    vi.stubGlobal(
      "Worker",
      class {
        onmessage?: (event: { data: { result: PlanFlows } }) => void;
        onerror = () => {};
        constructor() {
          deliver = (result) => this.onmessage?.({ data: { result } });
        }
        postMessage = posted;
        terminate() {}
      },
    );
    const member = { designId: "closed-calculation", name: "Closed line", included: true };
    const summary = {
      id: member.designId,
      name: member.name,
      createdAt: "a",
      updatedAt: "a",
      closed: true,
    };
    let stored = {
      ...summary,
      project: project({
        recipes: [{ ...recipe("demo", [], [["oxygen", 1]]), isDemo: true }],
        nodes: [],
      }),
    };
    vi.mocked(readDesign).mockImplementation(async () => stored);
    useDesignStore.setState({ designs: [summary], activeDesignId: "other" });
    useNetworkStore.setState({
      catalogue: {
        account: "local",
        token: "t",
        revision: 0,
        dirty: false,
        networks: [{ id: "n", name: "Network", members: [member], sharing: {}, included: true }],
      },
    });
    const initial: PlanFlows = {
      materials: [
        {
          key: "item:oxygen",
          kind: "item",
          resourceId: "oxygen",
          label: "Oxygen",
          supply: 1,
          demand: 0,
        },
      ],
      power: { used: 0, made: 0 },
    };
    const hook = renderHook(() => useNetworkCalculations(0));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    await act(async () => deliver(initial));
    expect(hook.result.current.get(memberKey(member))).toEqual(initial);
    act(() => useFactoryStore.setState({ rateUnit: "minute" }));
    hook.rerender();
    expect(posted).toHaveBeenCalledTimes(1);
    await act(async () => useDesignStore.setState({ designs: [{ ...summary }] }));
    await waitFor(() => expect(hook.result.current.get(memberKey(member))?.stale).not.toBe(true));
    expect(posted).toHaveBeenCalledTimes(1);
    stored = { ...stored, updatedAt: "b", project: { ...stored.project, name: "Changed line" } };
    await act(async () => useDesignStore.setState({ designs: [{ ...summary, updatedAt: "b" }] }));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
    expect(hook.result.current.get(memberKey(member))?.stale).toBe(true);
    const changed = { ...initial, materials: [{ ...initial.materials[0], supply: 2 }] };
    await act(async () => deliver(changed));
    expect(hook.result.current.get(memberKey(member))?.materials[0].supply).toBe(2);
    await act(async () => useDesignStore.setState({ designs: [] }));
    await waitFor(() =>
      expect(hook.result.current.get(memberKey(member))?.error).toBe("Plan unavailable"),
    );
    expect(posted).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
