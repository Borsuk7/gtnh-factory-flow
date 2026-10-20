"use client";

import { create } from "zustand";
import { fetchCurrentUser, logoutCommunityUser } from "@/lib/community/client";
import type { CommunityUser } from "@/lib/community/types";

/**
 * One session, one store: the planner header, the community header, the share
 * dialog, and the browser all read the same signed-in user, so signing in
 * anywhere updates everywhere.
 */
interface CommunityAuthStore {
  user?: CommunityUser;
  hasHydrated: boolean;
  isHydrating: boolean;
  hydrate: () => Promise<void>;
  setUser: (user?: CommunityUser) => void;
  signOut: () => Promise<void>;
}

/** How long to wait before asking again who is signed in, after the server could not say. */
export const HYDRATE_RETRY_MS = 30_000;

export const useCommunityAuthStore = create<CommunityAuthStore>((set, get) => ({
  user: undefined,
  hasHydrated: false,
  isHydrating: false,
  hydrate: async () => {
    if (get().hasHydrated || get().isHydrating) {
      return;
    }

    set({ isHydrating: true });
    try {
      set({ user: await fetchCurrentUser(), hasHydrated: true });
    } catch {
      // The server could not say who this is (its database is down, or the
      // network is): not signed out, so ask again until it can.
      setTimeout(() => void get().hydrate(), HYDRATE_RETRY_MS);
    } finally {
      set({ isHydrating: false });
    }
  },
  setUser: (user) => set({ user, hasHydrated: true }),
  signOut: async () => {
    await logoutCommunityUser();
    set({ user: undefined });
  },
}));
