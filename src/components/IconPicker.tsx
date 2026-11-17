"use client";

import { Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets";
import {
  queryRecipeDatasetResources,
  type RecipeDatasetResourceQueryResult,
} from "@/lib/datasets/browser-loader";
import type { EntryIcon, PlanResourceStat } from "@/lib/community/types";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { applyRecipeInputOverrides } from "@/lib/model/recipe-input-overrides";
import { listNodeSections } from "@/lib/model/shared-machine";
import type { FactoryProject } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { ResourceIcon } from "./nei/ResourceIcon";
import { MinecraftTooltip } from "./nei/MinecraftTooltip";

const PICKER_PAGE = 60;

/**
 * The obvious candidates for an entry's face: what it makes, then what it
 * eats — shown at the top of the picker before any searching happens.
 */
export function iconSuggestionsFromStats(
  needs: readonly Omit<PlanResourceStat, "ratePerSecond">[] | undefined,
  outputs: readonly Omit<PlanResourceStat, "ratePerSecond">[] | undefined,
): EntryIcon[] {
  const seen = new Set<string>();
  const suggestions: EntryIcon[] = [];
  for (const stat of [...(outputs ?? []), ...(needs ?? [])]) {
    const key = `${stat.kind}:${stat.resourceId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    suggestions.push({
      kind: stat.kind,
      resourceId: stat.resourceId,
      displayName: stat.displayName,
      iconPath: stat.iconPath,
      iconAtlas: stat.iconAtlas,
      dominantColor: stat.dominantColor,
    });
    if (suggestions.length >= 16) {
      break;
    }
  }
  return suggestions;
}

export function iconSuggestionsFromProject(project: FactoryProject): EntryIcon[] {
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const suggestions = new Map<string, EntryIcon>();
  const add = (resource: {
    kind: string;
    resourceId: string;
    displayName?: string;
    iconPath?: string;
    iconAtlas?: EntryIcon["iconAtlas"];
    dominantColor?: string;
  }) => {
    const { kind, resourceId, displayName, iconPath, iconAtlas, dominantColor } = resource;
    if (kind !== "item" && kind !== "fluid") return;
    const key = `${kind}:${resourceId}`;
    const existing = suggestions.get(key);
    suggestions.set(key, {
      kind,
      resourceId,
      displayName: existing?.displayName ?? displayName,
      iconPath: existing?.iconPath ?? iconPath,
      iconAtlas: existing?.iconAtlas ?? iconAtlas,
      dominantColor: existing?.dominantColor ?? dominantColor,
    });
  };
  for (const drawer of project.storages ?? []) add(drawer);
  for (const card of project.nodes) {
    for (const { node } of listNodeSections(card)) {
      const recipe = recipes.get(node.recipeId);
      if (!recipe) continue;
      const { inputs, outputs } = applyRecipeInputOverrides(recipe, node);
      for (const resource of [...outputs, ...inputs]) add({ ...resource, resourceId: resource.id });
    }
  }
  for (const edge of project.edges) {
    add({ kind: edge.resourceKind, resourceId: edge.resourceId, displayName: edge.label });
  }
  return Array.from(suggestions.values());
}

/**
 * The one-item face chooser: search the dataset the same way the item
 * browser does, click an icon, done. A small modal so it works from
 * dialogs and list rows alike.
 */
export function IconPicker({
  title = "Pick an icon",
  portaled = false,
  suggestions,
  onPick,
  onClear,
  onClose,
}: {
  title?: string;
  portaled?: boolean;
  /** Resources used by the build, shown above the catalog. */
  suggestions?: EntryIcon[];
  onPick: (icon: EntryIcon) => void;
  /** Present when the caller already has an icon that can be removed. */
  onClear?: () => void;
  onClose: () => void;
}) {
  const datasetManifest = useFactoryStore((state) => state.datasetManifest);
  const datasetManifestUrl = useFactoryStore((state) => state.datasetManifestUrl);
  const selectedDatasetVersionId = useFactoryStore((state) => state.selectedDatasetVersionId);
  const version = datasetManifest?.versions.find(
    (entry) => entry.id === selectedDatasetVersionId,
  );

  const [query, setQuery] = useState("");
  const titleId = useId();
  const debouncedQuery = useDebouncedValue(query, 200);
  const [result, setResult] = useState<RecipeDatasetResourceQueryResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!version) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    queryRecipeDatasetResources(
      datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
      version,
      { query: debouncedQuery.trim(), offset: 0, limit: PICKER_PAGE, sort: "relevance" },
      { signal: controller.signal },
    )
      .then((response) => {
        if (!cancelled) {
          setError(undefined);
          setResult(response);
        }
      })
      .catch((queryError: unknown) => {
        if (!cancelled && (queryError as Error)?.name !== "AbortError") {
          setError(queryError instanceof Error ? queryError.message : "Search failed.");
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [datasetManifestUrl, debouncedQuery, version]);

  // Aspects have icons too, but they aren't things a factory makes.
  const resources = (result?.resources ?? []).filter((entry) => entry.kind !== "aspect");
  const needle = query.trim().toLowerCase();
  const buildResources = suggestions?.filter((icon) =>
    !needle || icon.displayName?.toLowerCase().includes(needle) || icon.resourceId.toLowerCase().includes(needle),
  );

  const picker = (
    <div
      className={`fixed inset-0 z-[120] grid place-items-center bg-neutral-950/50 p-4${portaled ? " ui-zoom" : ""}`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-icon-picker=""
        className="flex max-h-[calc(70*var(--ui-vh))] w-full max-w-sm flex-col rounded-[6px] border border-neutral-600 bg-[#25272c] p-3 text-neutral-100 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close icon picker"
            className="rounded p-1 text-neutral-400 hover:text-neutral-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-[4px] border border-neutral-700 bg-[#17191d] px-2 text-sm shadow-[inset_1px_1px_0_rgba(255,255,255,0.08)]">
          <Search className="h-4 w-4 text-neutral-500" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search item or fluid..."
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </label>
        {error ? <p className="mt-2 text-[11px] text-red-400">{error}</p> : null}
        {buildResources && buildResources.length > 0 ? (
          <div className="mt-2 min-h-0" role="group" aria-label="From this build">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              From this build
            </p>
            <div className="flex max-h-[min(7rem,25vh)] flex-wrap gap-1 overflow-y-auto">
              {buildResources.map((suggestion) => (
                <IconChoice
                  key={`${suggestion.kind}:${suggestion.resourceId}`}
                  icon={suggestion}
                  onPick={onPick}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-neutral-700 pt-2" role="group" aria-label="Item and fluid catalog">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-neutral-400">Item and fluid catalog</p>
          {!version ? (
            <p className="pt-1 text-[11px] text-neutral-500">The dataset is still loading…</p>
          ) : resources.length === 0 ? (
            <p className="pt-1 text-[11px] text-neutral-500">
              {result ? "Nothing matches." : "Searching…"}
            </p>
          ) : (
            <div className="grid grid-cols-8 gap-1">
              {resources.map((entry) => {
                const icon: EntryIcon = {
                  kind: entry.kind as EntryIcon["kind"],
                  resourceId: entry.id,
                  displayName: entry.displayName,
                  iconPath: entry.iconPath,
                  iconAtlas: entry.iconAtlas,
                  dominantColor: entry.dominantColor,
                };
                return (
                  <IconChoice key={`${entry.kind}:${entry.id}`} icon={icon} onPick={onPick} />
                );
              })}
            </div>
          )}
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="mt-2 h-7 shrink-0 rounded-[4px] border border-neutral-700 bg-[#17191d] text-[11px] text-neutral-400 hover:border-red-500 hover:text-red-400"
          >
            Remove the current icon
          </button>
        ) : null}
      </div>
    </div>
  );
  return portaled ? createPortal(picker, document.body) : picker;
}

function IconChoice({ icon, onPick }: { icon: EntryIcon; onPick: (icon: EntryIcon) => void }) {
  const name = icon.displayName || icon.resourceId;
  return (
    <MinecraftTooltip label={name} placement="above" openOnFocus>
      <button
        type="button"
        onClick={() => onPick(icon)}
        aria-label={name}
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-neutral-600 bg-[#17191d] hover:border-cyan-500"
      >
        <IconPreview icon={icon} />
      </button>
    </MinecraftTooltip>
  );
}

function IconPreview({ icon }: { icon: EntryIcon }) {
  if (!icon.iconPath && !icon.iconAtlas && icon.kind !== "fluid") {
    const initial = (icon.displayName ?? icon.resourceId).slice(0, 1).toUpperCase();
    return <span aria-hidden className="text-xs font-semibold text-neutral-400">{initial}</span>;
  }
  return (
    <ResourceIcon
      resource={{
        id: icon.resourceId,
        kind: icon.kind,
        amount: 1,
        displayName: icon.displayName,
        iconPath: icon.iconPath,
        iconAtlas: icon.iconAtlas,
        dominantColor: icon.dominantColor,
      }}
      bare
      tooltip={false}
      showAmount={false}
      className="!h-full !w-full"
    />
  );
}

/**
 * The icon slot lists and dialogs share: shows the picked face, or a
 * dashed empty square as the "pick one" affordance when editable.
 */
export function EntryIconSlot({
  icon,
  editable,
  onEdit,
  className,
}: {
  icon?: EntryIcon;
  editable?: boolean;
  onEdit?: () => void;
  className?: string;
}) {
  // Fills the slot: the padded source art is drawn at 200% and cropped by
  // the wrapper, so the sprite lands at roughly the slot's own size.
  const face = icon ? <IconPreview icon={icon} /> : null;

  if (!editable) {
    // Read-only rows without an icon give the space back to the name.
    if (!icon) {
      return null;
    }
    return (
      <span
        className={[
          "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden",
          className ?? "",
        ].join(" ")}
      >
        {face}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={icon ? "Change the icon" : "Pick an icon"}
      className={[
        "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border",
        icon
          ? "border-transparent hover:border-cyan-600"
          : "border-dashed border-neutral-600 text-neutral-600 hover:border-cyan-600 hover:text-cyan-400",
        className ?? "",
      ].join(" ")}
    >
      {face ?? <span className="text-[10px] leading-none">+</span>}
    </button>
  );
}
