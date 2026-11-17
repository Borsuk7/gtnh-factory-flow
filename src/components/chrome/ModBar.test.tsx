// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { writeWorkspaceView } from "@/lib/workspace-view";
import { OPEN_FEEDBACK_EVENT } from "./chrome-events";
import { ModBar } from "./ModBar";
import { useCommunityAuthStore } from "@/store/community-auth-store";
import { openLibrary, readLibraryTabState } from "@/lib/library/library-tab";

const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => viewport.compact, useIsCompactViewport: () => viewport.compact }));
const modLink = vi.hoisted(() => ({
  findModGame: vi.fn(),
  localNetworkPermission: vi.fn(),
  sendPlanToMod: vi.fn(),
}));
vi.mock("@/lib/mod-link/mod-link", () => modLink);
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/clipboard", () => clipboard);
// jsdom has no CompressionStream; the code itself is plan-code.test.ts's.
vi.mock("@/lib/import-export/plan-code", async (original) => ({
  ...(await original<typeof import("@/lib/import-export/plan-code")>()),
  encodePlanCode: vi.fn(async () => "gtnh1.TEST"),
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const noop = () => undefined;
function renderBar(overrides: Partial<Parameters<typeof ModBar>[0]> = {}) {
  return render(
    <ModBar onShare={noop} onScreenshot={noop} onSettings={noop} onChangelog={noop} onDevMenu={noop} unreadNotes={false} {...overrides} />,
  );
}
const shareLabels = () =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"] .mm-label')].map((element) => element.textContent);
const key = (id: string) => document.querySelector<HTMLElement>(`[data-mb="${id}"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  viewport.compact = false;
  modLink.localNetworkPermission.mockResolvedValue("unknown");
  modLink.findModGame.mockResolvedValue(undefined);
  modLink.sendPlanToMod.mockResolvedValue(false);
  clipboard.copyToClipboard.mockResolvedValue(true);
  window.localStorage.clear();
  useFactoryStore.setState({ rateUnit: "second", powerDisplayUnit: "eu", undoHistory: [], redoHistory: [], isReadOnly: false });
  useDesignStore.setState({ designs: [], publicViews: [], activeDesignId: undefined });
  writeWorkspaceView({ averageMachineDraw: true });
  useCommunityAuthStore.setState({ user: undefined, hasHydrated: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("the mod's top bar", () => {
  it("keeps file and link sharing available when online features are disabled", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_ONLINE_FEATURES", "false");
    renderBar();
    expect(key("account")).toBeNull();
    fireEvent.click(key("share"));
    expect(shareLabels()).toContain("Copy plan link");
    expect(shareLabels()).toContain("Export plan file");
    expect(shareLabels()).not.toContain("Post a copy to Community...");
  });
  it("every key is in the Tab order and Enter or Space presses it", () => {
    renderBar();
    for (const id of ["plans", "share", "account", "feedback", "settings", "help"]) {
      expect(key(id).getAttribute("tabindex"), id).toBe("0");
    }
    key("plans").focus();
    fireEvent.keyDown(key("plans"), { key: "Enter" });
    expect(readLibraryTabState().active).toBe(true);
    fireEvent.keyDown(key("plans"), { key: " " });
    expect(readLibraryTabState().active).toBe(false);
  });

  it("holds the account's keys only, in order: Plans, Share, the account, feedback, settings, help", () => {
    renderBar();
    const order = [...document.querySelectorAll("[data-mb]")].map((element) => element.getAttribute("data-mb"));
    expect(order).toEqual(["plans", "share", "account", "feedback", "settings", "help"]);
    expect(key("plans").textContent).toBe("Plans");
    expect(key("account").textContent).toBe("Sign in");
  });

  it("Plans opens the library on My plans, stays open on any shelf, and shuts it from there", () => {
    renderBar();
    fireEvent.click(key("plans"));
    expect(readLibraryTabState().view.kind).toBe("all");
    act(() => openLibrary({ kind: "public" }));
    expect(key("plans").hasAttribute("data-open")).toBe(true);
    fireEvent.click(key("plans"));
    expect(readLibraryTabState().active).toBe(false);
    expect(key("plans").hasAttribute("data-open")).toBe(false);
  });

  it("the account key is the account's face once signed in, with a menu of the username and Sign out", () => {
    useCommunityAuthStore.setState({ user: { username: "ann_smith" }, hasHydrated: true });
    renderBar();
    expect(key("account").textContent).toBe("AS");
    fireEvent.click(key("account"));
    const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"] .mm-label')].map((element) => element.textContent);
    expect(rows).toEqual(["ann_smith", "Sign out"]);
  });

  const shareRows = () =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"] .mm-label')].map((element) => element.textContent);
  const shareRow = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
      (row) => row.querySelector(".mm-label")?.textContent === label,
    )!;
  const openShare = async () => {
    await act(async () => {
      fireEvent.click(key("share"));
    });
  };

  it("the Share key opens its menu in the mod's words: Save to library, the link, the code, the file, the game, a picture", async () => {
    renderBar();
    await openShare();
    expect(shareRows()).toEqual([
      "Copy plan link",
      "Copy plan code",
      "Export plan file",
      "Screenshot...",
      "Open in the game",
      "Post a copy to Community...",
    ]);
  });

  it("a plan already posted offers Update in library and Post a new copy to Community, each opening the dialog for it", async () => {
    const onShare = vi.fn();
    useFactoryStore.setState({
      project: { ...useFactoryStore.getState().project, metadata: { communityPlanId: "post-1" } },
    });
    renderBar({ onShare });
    await openShare();
    expect(shareRows().slice(-2)).toEqual(["Update in Community...", "Post a new copy to Community..."]);
    fireEvent.click(shareRow("Post a new copy to Community..."));
    expect(onShare).toHaveBeenCalledWith("new");
  });

  it("Open in the mod is greyed with a tip while no game answers", async () => {
    renderBar();
    await openShare();
    const row = shareRow("Open in the game");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("data-tip")).toContain("Start the game with GTNH Planner installed");
    fireEvent.click(row);
    expect(modLink.sendPlanToMod).not.toHaveBeenCalled();
  });

  it("Open in the mod sends the plan to the game that answered", async () => {
    modLink.findModGame.mockResolvedValue({ port: 25641, version: "0.2.0" });
    modLink.sendPlanToMod.mockResolvedValue(true);
    renderBar();
    await openShare();
    const row = shareRow("Open in the game");
    expect(row.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(row);
    });
    await vi.waitFor(() => expect(modLink.sendPlanToMod).toHaveBeenCalled());
    const [code, , game] = modLink.sendPlanToMod.mock.calls[0];
    expect(code).toMatch(/^gtnh1\./);
    expect(game).toEqual({ port: 25641, version: "0.2.0" });
    expect(clipboard.copyToClipboard).not.toHaveBeenCalled();
  });

  it("Open in the mod falls back to copying the plan code when the game cannot be reached", async () => {
    modLink.findModGame.mockResolvedValue({ port: 25640, version: "0.2.0" });
    renderBar();
    await openShare();
    await act(async () => {
      fireEvent.click(shareRow("Open in the game"));
    });
    await vi.waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalled());
    expect(clipboard.copyToClipboard.mock.calls[0][0]).toMatch(/^gtnh1\./);
  });

  it("a browser that asks before reaching this computer is not probed until the row is picked", async () => {
    modLink.localNetworkPermission.mockResolvedValue("prompt");
    renderBar();
    await openShare();
    expect(modLink.findModGame).not.toHaveBeenCalled();
    expect(shareRow("Open in the game").getAttribute("aria-disabled")).toBeNull();
  });

  it("a browser told no still reaches a game it may, and else the row copies the code for the + tab", async () => {
    modLink.localNetworkPermission.mockResolvedValue("denied");
    modLink.findModGame.mockResolvedValue({ port: 25640, version: "0.2.0" });
    renderBar();
    await openShare();
    expect(shareRow("Open in the game").getAttribute("aria-disabled")).toBeNull();
    cleanup();
    modLink.findModGame.mockResolvedValue(undefined);
    renderBar();
    await openShare();
    const row = shareRow("Open in the game");
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.getAttribute("data-tip")).toContain("copies the plan code");
    await act(async () => {
      fireEvent.click(row);
    });
    await vi.waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalledWith("gtnh1.TEST"));
    expect(modLink.sendPlanToMod).not.toHaveBeenCalled();
  });

  it("Copy plan link copies this site's link with the plan after #p=, Copy plan code the code alone", async () => {
    renderBar();
    await openShare();
    await act(async () => {
      fireEvent.click(shareRow("Copy plan link"));
    });
    await vi.waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(1));
    expect(clipboard.copyToClipboard.mock.calls[0][0].startsWith(`${window.location.origin}/#p=gtnh1.`)).toBe(true);
    await openShare();
    await act(async () => {
      fireEvent.click(shareRow("Copy plan code"));
    });
    await vi.waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(2));
    expect(clipboard.copyToClipboard.mock.calls[1][0]).toMatch(/^gtnh1\./);
  });

  it("the Help key lists the tour, controls, welcome, release notes and mod download", () => {
    renderBar();
    fireEvent.click(key("help"));
    const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"] .mm-label')].map((element) => element.textContent);
    expect(rows).toEqual(["Take the tour", "Controls and shortcuts", "Welcome", "What's new", "Download the mod"]);
    fireEvent.click(screen.getByText("Controls and shortcuts"));
    expect(screen.getByRole("dialog", { name: "How the board works" })).toBeTruthy();
    expect(document.querySelectorAll(".mc-controls-row")).toHaveLength(19);
  });

  it("the Help menu's Download the mod opens the mod's newest release", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderBar();
    fireEvent.click(key("help"));
    fireEvent.click(screen.getByText("Download the mod"));
    expect(open).toHaveBeenCalledWith("https://github.com/jackwrichards/gtnh-planner-mod/releases/latest", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("the Feedback key knocks on the feedback door, and a part that answers takes it", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderBar();
    fireEvent.click(key("feedback"));
    expect(open).toHaveBeenCalledTimes(1);
    const heard = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(OPEN_FEEDBACK_EVENT, heard);
    fireEvent.click(key("feedback"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_FEEDBACK_EVENT, heard);
    open.mockRestore();
  });

  it("every key carries a tip for the tip host", () => {
    renderBar();
    for (const id of ["plans", "share", "account", "feedback", "settings", "help"]) {
      expect(key(id).getAttribute("data-tip-id"), id).toBe(`bar|${id}`);
      expect(JSON.parse(key(id).getAttribute("data-tip")!).title.length).toBeGreaterThan(3);
    }
  });
});

/**
 * The bar steps from the room its tabs have. jsdom lays nothing out, so the bar's width is stubbed (bar px), the tab
 * strip is what the keys leave of it (each key's width by its dress), and the observer fires when a test says so.
 */
describe("the top bar's one row", () => {
  const LABEL_WIDTH: Record<string, number> = { plans: 42, share: 42, account: 49 };
  const GAP = 2;
  const PADDING = 8;
  let barWidth = 0;
  const watchers = new Set<() => void>();

  /** A key's width as the browser would give it: an icon key 18, a labelled one by its word. */
  const keyWidth = (element: Element) =>
    element.hasAttribute("data-mb") ? (element.hasAttribute("data-icon") ? 18 : (LABEL_WIDTH[element.getAttribute("data-mb")!] ?? 30)) : 0;
  const tabsWidth = (bar: Element) =>
    Math.max(
      66,
      barWidth - PADDING - [...bar.children].filter((child) => child.hasAttribute("data-mb")).reduce((sum, child) => sum + keyWidth(child) + GAP, 0),
    );

  beforeEach(() => {
    barWidth = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          watchers.add(this.callback);
        }
        unobserve() {}
        disconnect() {
          watchers.delete(this.callback);
        }
      },
    );
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-mod-bar")) return barWidth;
      if (this.classList.contains("mt")) return tabsWidth(this.parentElement!);
      return 0;
    });
  });
  afterEach(() => {
    watchers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The bar is this wide now: every observer hears of it. */
  const resize = (width: number) => {
    barWidth = width;
    act(() => {
      for (const callback of [...watchers]) callback();
    });
  };
  const bar = () => document.querySelector<HTMLElement>("[data-mod-bar]")!;
  const fit = () => bar().getAttribute("data-fit");
  const isIcon = (id: string) => key(id).hasAttribute("data-icon");
  // The roomy bar needs 207 of keys beside the tabs, the icon bar 128: with two full tabs and the + kept (260) the keys
  // become icons below 467 and the gaps tighten below 266; they come back from 479 and 345.
  const ICONS_BELOW = 467;

  it("keeps Plans, Share and Sign in as words while the tabs have room", () => {
    renderBar();
    resize(900);
    expect(fit()).toBe("roomy");
    expect(key("plans").textContent).toBe("Plans");
    expect(key("share").textContent).toBe("Share");
    expect(key("account").textContent).toBe("Sign in");
    expect(isIcon("plans") || isIcon("share") || isIcon("account")).toBe(false);
  });

  it("Plans, Share and Sign in become small icon keys like feedback, settings and help, in the same places", () => {
    renderBar();
    resize(ICONS_BELOW - 1);
    expect(fit()).toBe("icons");
    for (const id of ["plans", "share", "account", "feedback", "settings", "help"]) {
      expect(isIcon(id), id).toBe(true);
      expect(key(id).textContent, id).toBe("");
      expect(key(id).querySelector("svg"), id).not.toBeNull();
    }
    expect([...document.querySelectorAll("[data-mod-bar] > [data-mb]")].map((element) => element.getAttribute("data-mb"))).toEqual([
      "plans",
      "share",
      "account",
      "feedback",
      "settings",
      "help",
    ]);
  });

  it("each icon key keeps its name for a screen reader and leads its tip with it", () => {
    renderBar();
    resize(ICONS_BELOW - 1);
    expect(key("plans").getAttribute("aria-label")).toBe("Plans");
    expect(key("share").getAttribute("aria-label")).toBe("Share");
    expect(key("account").getAttribute("aria-label")).toBe("Sign in");
    for (const [id, name] of [
      ["plans", "Plans"],
      ["share", "Share"],
      ["account", "Sign in"],
    ]) {
      expect(JSON.parse(key(id).getAttribute("data-tip")!).title.startsWith(name), id).toBe(true);
    }
  });

  it("an icon key does what the labelled key did", async () => {
    renderBar();
    resize(ICONS_BELOW - 1);
    fireEvent.click(key("plans"));
    expect(readLibraryTabState().active).toBe(true);
    fireEvent.click(key("plans"));
    expect(readLibraryTabState().active).toBe(false);
    await act(async () => {
      fireEvent.click(key("share"));
    });
    expect(shareLabels()).toContain("Copy plan link");
    fireEvent.click(key("account"));
    expect(key("account").getAttribute("aria-expanded")).toBe("true");
  });

  it("the gaps tighten after the icons, and the keys stay icons", () => {
    renderBar();
    resize(ICONS_BELOW - 1);
    expect(fit()).toBe("icons");
    resize(250);
    expect(fit()).toBe("tight");
    resize(100);
    expect(fit()).toBe("tight");
    expect(isIcon("plans")).toBe(true);
  });

  it("holds its dress at the edge, and goes back to words a little roomier than it left them", () => {
    renderBar();
    resize(ICONS_BELOW - 1);
    expect(fit()).toBe("icons");
    // The icon dress gives the tabs 79, so the words are back only where they would leave 260 and a little over.
    resize(ICONS_BELOW + 10);
    expect(fit()).toBe("icons");
    resize(ICONS_BELOW + 12 + 4);
    expect(fit()).toBe("roomy");
    expect(key("plans").textContent).toBe("Plans");
  });

  it("goes once to icons and once back as the window narrows and widens, never flickering between", () => {
    renderBar();
    const seen: Array<string | null> = [];
    for (let width = 700; width >= 200; width -= 3) {
      resize(width);
      seen.push(fit());
    }
    for (let width = 200; width <= 700; width += 3) {
      resize(width);
      seen.push(fit());
    }
    const stretches = seen.filter((value, at) => at === 0 || value !== seen[at - 1]);
    expect(stretches).toEqual(["roomy", "icons", "tight", "icons", "roomy"]);
  });

  it("starts again from the words when what the bar holds changes (signing in swaps Sign in for a face)", () => {
    renderBar();
    resize(ICONS_BELOW - 1);
    expect(fit()).toBe("icons");
    act(() => useCommunityAuthStore.setState({ user: { username: "ann_smith" }, hasHydrated: true }));
    // The face is 18 wide, 31 less than the word: the tabs have 260 again with the words.
    expect(fit()).toBe("roomy");
    expect(key("plans").textContent).toBe("Plans");
    expect(key("account").textContent).toBe("AS");
  });

  it("a phone's bar keeps its words and its own give-way, and its two drawer keys", () => {
    viewport.compact = true;
    renderBar();
    resize(ICONS_BELOW - 1);
    expect(key("plans").textContent).toBe("Plans");
    expect(key("account").textContent).toBe("Sign in");
    expect(key("drawer-side")).not.toBeNull();
    expect(key("drawer-items")).not.toBeNull();
    expect(fit()).toBe("tight");
  });

  it("a desktop window has no Overview or Items key", () => {
    renderBar();
    resize(500);
    expect(key("drawer-side")).toBeNull();
    expect(key("drawer-items")).toBeNull();
  });
});
