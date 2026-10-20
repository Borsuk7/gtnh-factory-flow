import { afterEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
  logoutCommunityUser: vi.fn(),
}));
vi.mock("@/lib/community/client", () => client);

import { HYDRATE_RETRY_MS, useCommunityAuthStore } from "./community-auth-store";

afterEach(() => {
  vi.useRealTimers();
  client.fetchCurrentUser.mockReset();
  useCommunityAuthStore.setState({ user: undefined, hasHydrated: false, isHydrating: false });
});

describe("community auth store", () => {
  it("asks again when the server cannot say who is signed in, rather than signing them out", async () => {
    vi.useFakeTimers();
    client.fetchCurrentUser.mockRejectedValueOnce(new Error("Account check failed (503)"));
    client.fetchCurrentUser.mockResolvedValueOnce({ username: "ann", isAdmin: false });

    await useCommunityAuthStore.getState().hydrate();
    expect(useCommunityAuthStore.getState()).toMatchObject({ user: undefined, hasHydrated: false });

    await vi.advanceTimersByTimeAsync(HYDRATE_RETRY_MS);
    expect(useCommunityAuthStore.getState()).toMatchObject({
      user: { username: "ann" },
      hasHydrated: true,
    });
    expect(client.fetchCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("asks once when the server answers", async () => {
    vi.useFakeTimers();
    client.fetchCurrentUser.mockResolvedValue(undefined);
    await useCommunityAuthStore.getState().hydrate();
    await vi.advanceTimersByTimeAsync(HYDRATE_RETRY_MS * 3);
    expect(useCommunityAuthStore.getState()).toMatchObject({ user: undefined, hasHydrated: true });
    expect(client.fetchCurrentUser).toHaveBeenCalledTimes(1);
  });
});
