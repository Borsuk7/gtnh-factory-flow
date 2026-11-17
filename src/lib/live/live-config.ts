import { liveSocketUrl } from "./protocol";
import { areOnlineFeaturesEnabled } from "@/lib/online-features";

/**
 * Whether this build has live plans at all: NEXT_PUBLIC_LIVE_URL set at build
 * time. Unset, every live feature (live editing, sharing, presence, the task
 * board) stays out of sight and the site behaves exactly as before.
 *
 * The variable is read by its literal name so Next.js inlines it.
 */
export function isLiveConfigured(): boolean {
  return areOnlineFeaturesEnabled() && Boolean(process.env.NEXT_PUBLIC_LIVE_URL?.trim());
}

/** The live socket's address for this page, or undefined when live plans are off. */
export function liveSocketAddress(): string | undefined {
  if (!isLiveConfigured() || typeof window === "undefined") {
    return undefined;
  }
  return liveSocketUrl(process.env.NEXT_PUBLIC_LIVE_URL, window.location);
}
