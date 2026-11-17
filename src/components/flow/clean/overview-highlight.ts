"use client";

import { useLayoutEffect, useRef } from "react";

const litWrappers = new WeakMap<HTMLElement, number>();

/** Lift the existing wrapper while any of its rows matches the overview resource. */
export function useOverviewHighlight(lit: boolean) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!lit) return;
    const wrapper = element.current?.closest<HTMLElement>(".react-flow__node");
    if (!wrapper) return;
    litWrappers.set(wrapper, (litWrappers.get(wrapper) ?? 0) + 1);
    wrapper.setAttribute("data-overview-lit", "");
    return () => {
      const count = (litWrappers.get(wrapper) ?? 1) - 1;
      if (count > 0) {
        litWrappers.set(wrapper, count);
      } else {
        litWrappers.delete(wrapper);
        wrapper.removeAttribute("data-overview-lit");
      }
    };
  }, [lit]);
  return element;
}
