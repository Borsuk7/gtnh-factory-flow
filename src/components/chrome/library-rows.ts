import type { ShareMode } from "@/components/community/SharePlanDialog";
import { isLiveConfigured } from "@/lib/live/live-config";
import { areOnlineFeaturesEnabled } from "@/lib/online-features";
import type { MenuEntry } from "./ChromeMenu";

/**
 * The rows that put a plan in the library, in the Share menu and a tab's menu, in the mod's words: a plan not
 * posted yet has Save to library; one posted has Update in library (its own post, votes kept) and Save as new
 * post. A post is a copy: nothing follows the plan by itself. With live plans, Share with people invites people
 * into the plan itself, so posting a copy is Publish to library (the mod's words there too): never one word for both.
 */
export function libraryRows(
  linked: boolean,
  open: (mode: ShareMode) => void,
  options: { disabled?: boolean; taskBoard?: boolean } = {},
): MenuEntry[] {
  // A task board is never posted to the library.
  if (!areOnlineFeaturesEnabled() || options.taskBoard) return [];
  if (!linked) {
    return [
      isLiveConfigured()
        ? { label: "Post a copy to Community...", detail: "a copy for everyone", onSelect: () => open("save"), disabled: options.disabled }
        : { label: "Post a copy to Community...", detail: "for other players", onSelect: () => open("save"), disabled: options.disabled },
    ];
  }
  return [
    { label: "Update in Community...", detail: "with the plan as it is", onSelect: () => open("update"), disabled: options.disabled },
    { label: "Post a new copy to Community...", detail: "a post of its own", onSelect: () => open("new"), disabled: options.disabled },
  ];
}
