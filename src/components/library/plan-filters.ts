"use client";

import { useEffect, useMemo, useState } from "react";
import { useCommunityUser } from "@/components/community/auth";
import { listCommunityPlans } from "@/lib/community/client";
import { parsePlanSearch } from "@/lib/community/search-query";
import type { CommunityPlanSummary } from "@/lib/community/types";
import type { DesignSummary } from "@/lib/designs/design-library";
import type { LibraryView } from "@/lib/library/library-tab";
import { SETUPS_CHANGED_EVENT } from "@/lib/setups-tab";
import type { SetupFilters } from "./SetupsFilterBar";

const POSTS_PAGE_SIZE = 48;
const POSTS_MAX_PAGES = 6;

export const PLAN_SORTS = [
  { value: "edited", label: "Last edited" },
  { value: "name", label: "Name" },
  { value: "created", label: "Newest" },
  { value: "tier", label: "Highest tier" },
  { value: "power", label: "Highest power" },
  { value: "lowPower", label: "Lowest power" },
  { value: "machines", label: "Most machines" },
];

export function useFilteredPlans(
  designs: DesignSummary[],
  view: LibraryView,
  filters: SetupFilters,
  posts: Map<string, CommunityPlanSummary> | undefined,
) {
  const { query, maxTier, maxEuT, makesKeys, takesKeys, sort } = filters;
  const folderId = view.kind === "folder" ? view.folderId : undefined;
  const favoritesOnly = view.kind === "favorites";
  const shown = useMemo(() => {
    const { text, tags } = parsePlanSearch(query);
    const name = text.toLowerCase();
    const tierLimit = maxTier === "" ? undefined : Number(maxTier);
    return sortDesignsBy(designs.filter((design) =>
      (!folderId || design.folderId === folderId) &&
      (!favoritesOnly || design.favorite === true) &&
      (!name || design.name.toLowerCase().includes(name)) &&
      tags.every((tag) => posts?.get(design.communityPlanId ?? "")?.tags.includes(tag)) &&
      (maxEuT === undefined || (design.stats?.euT !== undefined && design.stats.euT <= maxEuT)) &&
      makesKeys.every((key) => design.stats?.makes?.includes(key)) &&
      takesKeys.every((key) => design.stats?.takes?.includes(key)) &&
      (tierLimit === undefined || (design.stats !== undefined && design.stats.tierIndex <= tierLimit)),
    ), sort);
  }, [designs, folderId, favoritesOnly, query, posts, maxEuT, makesKeys, takesKeys, maxTier, sort]);
  const knownTags = useMemo(() => [...(posts?.values() ?? [])].flatMap((post) => post.tags ?? []), [posts]);
  const hasFilters = Boolean(query.trim() || maxTier || maxEuT !== undefined || makesKeys.length || takesKeys.length);
  return { shown, knownTags, hasFilters };
}

function sortDesignsBy(designs: DesignSummary[], sort: string): DesignSummary[] {
  const sorted = [...designs];
  switch (sort) {
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      break;
    case "created":
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      break;
    case "tier":
      sorted.sort((a, b) => (b.stats?.tierIndex ?? -1) - (a.stats?.tierIndex ?? -1));
      break;
    case "power":
      sorted.sort((a, b) => (b.stats?.euT ?? -1) - (a.stats?.euT ?? -1));
      break;
    case "lowPower":
      // A design with no figure yet goes last, not first.
      sorted.sort((a, b) => (a.stats?.euT ?? Infinity) - (b.stats?.euT ?? Infinity));
      break;
    case "machines":
      sorted.sort((a, b) => (b.stats?.machines ?? -1) - (a.stats?.machines ?? -1));
      break;
    case "edited":
    default:
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return sorted;
}

/**
 * The signed-in account's posts by id, or undefined while signed out or
 * still loading. Read once per sign-in and again whenever a share lands or
 * a post is changed from here.
 */
export function useMyPosts(): { posts: Map<string, CommunityPlanSummary> | undefined; signedIn: boolean } {
  const { user } = useCommunityUser();
  const username = user?.username;
  const [loaded, setLoaded] = useState<{
    username: string;
    posts: Map<string, CommunityPlanSummary>;
  }>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => setTick((value) => value + 1);
    window.addEventListener(SETUPS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SETUPS_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!username) {
      return;
    }
    let cancelled = false;
    (async () => {
      const found = new Map<string, CommunityPlanSummary>();
      for (let page = 1; page <= POSTS_MAX_PAGES; page += 1) {
        const response = await listCommunityPlans({
          mine: true,
          sort: "new",
          page,
          pageSize: POSTS_PAGE_SIZE,
        });
        for (const plan of response.plans) {
          found.set(plan.id, plan);
        }
        if (response.plans.length < POSTS_PAGE_SIZE || found.size >= response.total) {
          break;
        }
      }
      if (!cancelled) {
        setLoaded({ username, posts: found });
      }
    })().catch(() => {
      // The marks fall back to "linked"; nothing else depends on this.
    });
    return () => {
      cancelled = true;
    };
  }, [username, tick]);

  return {
    posts: loaded && loaded.username === username ? loaded.posts : undefined,
    signedIn: Boolean(username),
  };
}
