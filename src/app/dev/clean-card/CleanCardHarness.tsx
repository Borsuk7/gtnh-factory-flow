"use client";

import { useEffect } from "react";
import { FactoryPlannerApp } from "@/components/FactoryPlannerApp";
import { mockPlans } from "@/lib/solver/plan/__fixtures__/mock-extras";
import type { ThroughputResult } from "@/lib/model/types";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

/** How long a mock's result is put back over the board's own solve of its project (that solve lands late). */
const HOLD_MS = 8000;

/** Once a page load: development runs effects twice, and a second import would open the mock twice. */
let opened = false;

/** Opens a mock as a design of its own (off the welcome page and the shelf) and shows its result on the board. */
async function openMock(mock: (typeof mockPlans)[number]): Promise<void> {
  await useDesignStore.getState().importProjectAsDesign(structuredClone(mock.project), mock.name);
  let ours: ThroughputResult | undefined;
  const put = () => {
    ours = structuredClone(mock.result);
    useFactoryStore.setState({ lastResult: ours });
  };
  put();
  // The board solves the project it just opened; the mock's result goes back over that answer for a while.
  const unsubscribe = useFactoryStore.subscribe((state) => {
    if (state.lastResult !== ours && state.lastResult?.plan !== undefined) put();
  });
  setTimeout(unsubscribe, HOLD_MS);
}

/**
 * Exposes the store and the plan-mode mock results so a browser session can load
 * them into the real board: `__ccStore.setState({ project, lastResult })`.
 * `?mock=<index>` does it from the link (4 is the dead loop and clog lock).
 */
export function CleanCardHarness() {
  useEffect(() => {
    const w = window as unknown as {
      __ccStore?: typeof useFactoryStore;
      __ccMocks?: typeof mockPlans;
    };
    w.__ccStore = useFactoryStore;
    w.__ccMocks = mockPlans;
    const want = new URLSearchParams(window.location.search).get("mock");
    const mock = want === null ? undefined : mockPlans[Number(want)];
    if (!mock || opened) return;
    opened = true;
    if (useDesignStore.getState().isHydrated) {
      void openMock(mock);
      return;
    }
    const unsubscribe = useDesignStore.subscribe((state) => {
      if (!state.isHydrated) return;
      unsubscribe();
      void openMock(mock);
    });
  }, []);
  return <FactoryPlannerApp />;
}
