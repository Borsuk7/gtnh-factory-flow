import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets";
import {
  getRecipeDatasetRecipe,
  getRecipeDatasetRecipeIds,
  queryRecipeDatasetRecipes,
  resolveRecipeDatasetRecipes,
} from "@/lib/datasets/browser-loader";
import type { DatasetVersion } from "@/lib/datasets";
import type { FactoryEdge, FactoryProject, Recipe, ResourceKind } from "@/lib/model/types";
import {
  makeResourceHandleId,
  parseResourceHandleId,
  sectionHandleId,
  splitSectionHandleId,
} from "@/components/flow/resource-handles";
import { sectionNodeView } from "@/lib/model/shared-machine";
import { extractProjectJsonFromPng, extractProjectJsonFromSvg } from "@/lib/import-export/plan-image";
import { isPowerRecipe } from "@/lib/power/power-recipe";
import { pickRecipeRefMatch, recipeContentRef } from "@/lib/import-export/recipe-ref-match";
import { cloneImportedProject, parseFactoryProjectJson, serializeFactoryProject } from "@/lib/import-export";
import { untagCommunityPlan } from "@/lib/community/client";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { flashNotice } from "@/components/flow/clean/rail/NoticeBar";

export async function readProjectFile(file: File): Promise<string> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "svg" || file.type === "image/svg+xml") {
    const projectJson = extractProjectJsonFromSvg(await file.text());
    if (!projectJson) {
      throw new Error("This SVG does not contain a GTNH Planner plan.");
    }
    return projectJson;
  }

  if (extension === "png" || file.type === "image/png") {
    const projectJson = await extractProjectJsonFromPng(file);
    if (!projectJson) {
      throw new Error("This PNG does not contain a GTNH Planner plan.");
    }
    return projectJson;
  }

  return file.text();
}

export async function hydrateImportedProjectRecipes(
  project: FactoryProject,
  version: DatasetVersion,
): Promise<{
  project: FactoryProject;
  missingRecipes: Array<Pick<FactoryProject["recipes"][number], "id" | "name">>;
  migratedRecipes: Array<{
    fromId: string;
    toId: string;
    name: string;
    exact: boolean;
  }>;
}> {
  const availableRecipeIds = new Set(
    await getRecipeDatasetRecipeIds(DEFAULT_DATASET_MANIFEST_URL, version),
  );
  const importRecipesToResolve = project.recipes.filter(
    // Power cards own locally synthesized recipes (src/lib/power) that the
    // dataset can never answer for - and must never replace by name-match.
    (recipe) => !availableRecipeIds.has(recipe.id) && !isPowerRecipe(recipe) && !recipe.isDemo,
  );
  const resolvedRecipeIds = new Map(
    importRecipesToResolve.length
      ? (
          await resolveRecipeDatasetRecipes(
            DEFAULT_DATASET_MANIFEST_URL,
            version,
            importRecipesToResolve.map(recipeContentRef),
          )
        ).matches.map((match) => [match.importedId, match] as const)
      : [],
  );
  const missingRecipes: Array<Pick<FactoryProject["recipes"][number], "id" | "name">> = [];
  const migratedRecipes: Array<{ fromId: string; toId: string; name: string; exact: boolean }> =
    [];
  const recipeIdMigration = new Map<string, string>();

  const hydratedRecipes = await Promise.all(
    project.recipes.map(async (recipe) => {
      // A demo recipe is the plan's own data (nothing in the dataset can stand for it: a content match once turned
      // a demo methane source into the Underground Fluid map).
      if (recipe.isDemo) return recipe;
      if (isPowerRecipe(recipe)) {
        // Survives verbatim; normalizeLoadedProject resynthesizes it from
        // the node's settings on the way in.
        return recipe;
      }
      if (!availableRecipeIds.has(recipe.id)) {
        const contentMatch = resolvedRecipeIds.get(recipe.id);
        const migratedRecipe = contentMatch
          ? await getRecipeDatasetRecipe(DEFAULT_DATASET_MANIFEST_URL, version, contentMatch.recipeId)
          : await resolveImportedRecipe(version, recipe);
        if (migratedRecipe) {
          migratedRecipes.push({
            fromId: recipe.id,
            toId: migratedRecipe.id,
            name: recipe.name,
            exact: contentMatch?.exact ?? false,
          });
          recipeIdMigration.set(recipe.id, migratedRecipe.id);
          return migratedRecipe;
        }

        // Nothing in the dataset is close enough to stand in for it: the
        // plan's own embedded body keeps working, so it stays.
        missingRecipes.push({ id: recipe.id, name: recipe.name });
        return recipe;
      }

      return getRecipeDatasetRecipe(DEFAULT_DATASET_MANIFEST_URL, version, recipe.id);
    }),
  );
  const hydratedProject = {
    ...project,
    recipes: hydratedRecipes,
  };

  return {
    project: remapMigratedRecipeReferences(hydratedProject, recipeIdMigration),
    missingRecipes,
    migratedRecipes,
  };
}

function remapMigratedRecipeReferences(
  project: FactoryProject,
  recipeIdMigration: Map<string, string>,
): FactoryProject {
  if (recipeIdMigration.size === 0) {
    return project;
  }

  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const nodes = project.nodes.map((node) => {
    const migratedId = recipeIdMigration.get(node.recipeId);
    const carried = migratedId
      ? carryNodeOntoMigratedRecipe(node, recipesById.get(migratedId))
      : node;
    // A shared machine's extra recipes migrate by id like the first.
    const extras = carried.extraRecipes?.map((extra) => {
      const extraId = recipeIdMigration.get(extra.recipeId);
      return extraId ? { ...extra, recipeId: extraId } : extra;
    });
    return extras ? { ...carried, extraRecipes: extras } : carried;
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const originalNodesById = new Map(project.nodes.map((node) => [node.id, node] as const));

  return {
    ...project,
    nodes,
    edges: project.edges.map((edge) =>
      remapMigratedRecipeEdgeHandles(
        project,
        nodesById,
        originalNodesById,
        recipeIdMigration,
        edge,
      ),
    ),
  };
}

export function refreshImportedProjectEdges(project: FactoryProject): FactoryProject {
  if (project.edges.length === 0) {
    return project;
  }

  const nodesById = new Map(project.nodes.map((node) => [node.id, node] as const));
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const storagesById = new Map(
    (project.storages ?? []).map((storage) => [storage.id, storage] as const),
  );
  const edges = project.edges.map((edge) =>
    refreshImportedProjectEdgeHandles(edge, nodesById, recipesById, storagesById),
  );

  return { ...project, edges };
}

function refreshImportedProjectEdgeHandles(
  edge: FactoryEdge,
  nodesById: Map<string, FactoryProject["nodes"][number]>,
  recipesById: Map<string, Recipe>,
  storagesById: Map<string, NonNullable<FactoryProject["storages"]>[number]>,
): FactoryEdge {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const sourceRecipe = sectionRecipeAt(sourceNode, edge.sourceHandle, recipesById);
  const targetRecipe = sectionRecipeAt(targetNode, edge.targetHandle, recipesById);
  const sourceStorage = storagesById.get(edge.source);
  const targetStorage = storagesById.get(edge.target);

  return {
    ...edge,
    sourceHandle: sourceRecipe
      ? remapRecipeHandle(
          sourceRecipe,
          edge.sourceHandle,
          "output",
          edge.resourceKind,
          edge.resourceId,
        )
      : sourceStorage
        ? makeResourceHandleId("output", {
            kind: sourceStorage.kind,
            id: sourceStorage.resourceId,
          })
        : edge.sourceHandle,
    targetHandle: targetRecipe
      ? remapRecipeHandle(
          targetRecipe,
          edge.targetHandle,
          "input",
          edge.resourceKind,
          edge.resourceId,
        )
      : targetStorage
        ? makeResourceHandleId("input", {
            kind: targetStorage.kind,
            id: targetStorage.resourceId,
          })
        : edge.targetHandle,
  };
}

function remapMigratedRecipeEdgeHandles(
  project: FactoryProject,
  nodesById: Map<string, FactoryProject["nodes"][number]>,
  originalNodesById: Map<string, FactoryProject["nodes"][number]>,
  recipeIdMigration: Map<string, string>,
  edge: FactoryEdge,
): FactoryEdge {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  const originalSourceNode = originalNodesById.get(edge.source);
  const originalTargetNode = originalNodesById.get(edge.target);
  const sourceRecipeMigrated = Boolean(
    originalSourceNode && recipeIdMigration.has(originalSourceNode.recipeId),
  );
  const targetRecipeMigrated = Boolean(
    originalTargetNode && recipeIdMigration.has(originalTargetNode.recipeId),
  );

  if (!sourceRecipeMigrated && !targetRecipeMigrated) {
    return edge;
  }

  const migratedRecipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe] as const));
  const sourceRecipe = sectionRecipeAt(sourceNode, edge.sourceHandle, migratedRecipesById);
  const targetRecipe = sectionRecipeAt(targetNode, edge.targetHandle, migratedRecipesById);

  return {
    ...edge,
    sourceHandle:
      sourceRecipeMigrated && sourceRecipe
        ? remapRecipeHandle(
            sourceRecipe,
            edge.sourceHandle,
            "output",
            edge.resourceKind,
            edge.resourceId,
          )
        : edge.sourceHandle,
    targetHandle:
      targetRecipeMigrated && targetRecipe
        ? remapRecipeHandle(
            targetRecipe,
            edge.targetHandle,
            "input",
            edge.resourceKind,
            edge.resourceId,
          )
        : edge.targetHandle,
  };
}

/**
 * A shared machine's section prefix (`r2:`) rides through the remap untouched:
 * the handle behind it is repaired against that section's recipe and the
 * prefix put back.
 */
function remapRecipeHandle(
  recipe: Recipe,
  prefixedHandleId: string | undefined,
  expectedSide: "input" | "output",
  resourceKind: ResourceKind,
  resourceId: string,
): string | undefined {
  const { section, handleId } = splitSectionHandleId(prefixedHandleId);
  const bare = remapBareRecipeHandle(recipe, handleId, expectedSide, resourceKind, resourceId);
  return bare === undefined ? undefined : sectionHandleId(section, bare);
}

/** The recipe a wire's end reads at a card: the section its handle names. */
function sectionRecipeAt(
  node: FactoryProject["nodes"][number] | undefined,
  handleId: string | undefined,
  recipesById: Map<string, Recipe>,
): Recipe | undefined {
  if (!node) {
    return undefined;
  }
  const view = sectionNodeView(node, splitSectionHandleId(handleId).section);
  return recipesById.get(view.recipeId);
}

function remapBareRecipeHandle(
  recipe: Recipe,
  handleId: string | undefined,
  expectedSide: "input" | "output",
  resourceKind: ResourceKind,
  resourceId: string,
): string | undefined {
  const handle = parseResourceHandleId(handleId);
  const resources = expectedSide === "input" ? recipe.inputs : recipe.outputs;
  const handleResourceKind = handle?.kind ?? resourceKind;
  const handleResourceId = handle?.resourceId ?? resourceId;
  const slotIndex = parseResourceHandleSlotIndex(handleId);

  if (
    handle?.side === expectedSide &&
    resources.some(
      (resource, index) =>
        resource.kind === handleResourceKind &&
        resource.id === handleResourceId &&
        makeResourceHandleId(expectedSide, resource, index) === handleId,
    )
  ) {
    return handleId;
  }

  if (slotIndex !== undefined) {
    const indexedResource = resources[slotIndex];
    if (indexedResource?.kind === handleResourceKind && indexedResource.id === handleResourceId) {
      return makeResourceHandleId(expectedSide, indexedResource, slotIndex);
    }
  }

  const nextIndex = resources.findIndex(
    (resource) => resource.kind === resourceKind && resource.id === resourceId,
  );
  if (nextIndex !== -1) {
    return makeResourceHandleId(expectedSide, resources[nextIndex], nextIndex);
  }

  const matchingHandleIndex = resources.findIndex(
    (resource) => resource.kind === handleResourceKind && resource.id === handleResourceId,
  );
  return matchingHandleIndex === -1
    ? handleId
    : makeResourceHandleId(expectedSide, resources[matchingHandleIndex], matchingHandleIndex);
}

function parseResourceHandleSlotIndex(handleId: string | undefined): number | undefined {
  const rawIndex = handleId?.split(":")[3];
  if (rawIndex === undefined) {
    return undefined;
  }

  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

async function resolveImportedRecipe(
  version: DatasetVersion,
  importedRecipe: Recipe,
): Promise<Recipe | undefined> {
  const candidates = await queryRecipeDatasetRecipes(DEFAULT_DATASET_MANIFEST_URL, version, {
    query: importedRecipe.name,
    mode: "recipes",
    maxTier: "all",
    offset: 0,
    limit: 40,
  });
  // A name search is the last resort, and it only ever hands back a recipe
  // that takes and makes the same things: a same-named recipe with other
  // inputs (the second Steel Ingot blast furnace recipe) is not this one.
  const match = pickRecipeRefMatch(
    recipeContentRef(importedRecipe),
    candidates.recipes.map((candidate) => ({
      ...candidate,
      source: candidate.source ?? { recipeMap: candidate.recipeMap },
    })),
  );

  return match && match.score >= RECIPE_MIGRATION_SCORE
    ? getRecipeDatasetRecipe(DEFAULT_DATASET_MANIFEST_URL, version, match.candidate.id)
    : undefined;
}

/** Below this the likeness is too loose to swap a plan's recipe for. */
const RECIPE_MIGRATION_SCORE = 300;

/**
 * A node whose recipe was migrated keeps only the choices the new recipe
 * can honour: a handler id the new recipe does not list is dropped (the
 * card falls back to its first handler, as a dataset load would leave it),
 * and slot overrides move from the old recipe's slot numbers to the slot
 * holding the same resource on the new one, since the exporter's slot
 * order is not part of what makes two recipes the same.
 */
function carryNodeOntoMigratedRecipe(
  node: FactoryProject["nodes"][number],
  recipe: Recipe | undefined,
): FactoryProject["nodes"][number] {
  if (!recipe) {
    return node;
  }
  const carried: FactoryProject["nodes"][number] = { ...node, recipeId: recipe.id };
  if (
    node.machineHandlerId &&
    !(recipe.machineHandlers ?? []).some((handler) => handler.id === node.machineHandlerId)
  ) {
    delete carried.machineHandlerId;
  }
  const overrides = node.recipeInputOverrides;
  if (overrides) {
    const claimed = new Set<number>();
    const rekeyed: NonNullable<typeof overrides> = {};
    for (const override of Object.values(overrides)) {
      if (!override) {
        continue;
      }
      const index = recipe.inputs.findIndex(
        (input, inputIndex) =>
          !claimed.has(inputIndex) &&
          input.kind === override.kind &&
          (input.id === override.id ||
            input.alternatives?.some((alternative) => alternative.id === override.id)),
      );
      if (index === -1) {
        continue;
      }
      claimed.add(index);
      rekeyed[String(index)] = override;
    }
    if (Object.keys(rekeyed).length > 0) {
      carried.recipeInputOverrides = rekeyed;
    } else {
      delete carried.recipeInputOverrides;
    }
  }
  return carried;
}


/** True when pasted text is a plan file (JSON) rather than a link or code. */
export function looksLikePlanJson(text: string): boolean {
  return /^\s*\{/.test(text);
}

/**
 * Open plan JSON (an exported file's text, or the same pasted) as a NEW design tab, never over the plan on the
 * board. Recipes are hydrated against the selected dataset; ones it lacks keep the plan's embedded body.
 */
export async function openPlanJsonText(text: string, fallbackName = "Imported plan"): Promise<void> {
  const factory = useFactoryStore.getState();
  const selectedDatasetVersion = factory.datasetManifest?.versions.find(
    (version) => version.id === factory.selectedDatasetVersionId,
  );
  const importedProject = refreshImportedProjectEdges(
    cloneImportedProject(untagCommunityPlan(parseFactoryProjectJson(text)) as FactoryProject),
  );
  const name = importedProject.name || fallbackName;
  const { importProjectAsDesign } = useDesignStore.getState();
  // A new tab has no camera of its own yet, so it lands framed on the imported cards.
  if (!selectedDatasetVersion) {
    await importProjectAsDesign(importedProject, name);
    return;
  }
  const hydration = await hydrateImportedProjectRecipes(importedProject, selectedDatasetVersion);
  await importProjectAsDesign(refreshImportedProjectEdges(hydration.project), name);
}

/** Open a plan file (.json, or a .png / .svg picture that carries the plan) as a new design tab. */
export async function openPlanFile(file: File): Promise<void> {
  const { setProjectImporting } = useFactoryStore.getState();
  setProjectImporting(true);
  try {
    await openPlanJsonText(await readProjectFile(file), file.name.replace(/\.[^.]+$/, ""));
  } finally {
    setProjectImporting(false);
  }
}

/**
 * Files dropped on a plan board: a plan file (.json, or a picture that carries a plan) opens as a new plan. Any other
 * picture is directed to the annotation tool so screenshots can still open as plans.
 */
export async function dropFilesOnPlanBoard(files: File[]): Promise<void> {
  const planFile = files.find((file) => /\.json$/i.test(file.name) || file.type === "application/json");
  const picture = files.find((file) => file.type.startsWith("image/"));
  try {
    if (planFile) {
      await openPlanFile(planFile);
    } else if (picture) {
      // A screenshot the planner saved carries its plan; any other picture does not.
      try {
        await openPlanFile(picture);
      } catch {
        flashNotice("info", "To place a picture, open Annotations and choose Add an image.");
      }
    } else {
      flashNotice("info", "That file is not a plan. Drop a .json plan file.");
    }
  } catch (error) {
    flashNotice("warn", error instanceof Error ? error.message : "That plan file could not be opened.");
  }
}

/** Save the open plan as a .json file the browser downloads (Open plan file... reads it back). */
export function downloadPlanFile(project: FactoryProject): void {
  const blob = new Blob([serializeFactoryProject(project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "factory"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
