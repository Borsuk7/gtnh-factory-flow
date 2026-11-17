"use client";

import { useState } from "react";
import { EntryIconSlot, IconPicker, iconSuggestionsFromStats } from "@/components/IconPicker";
import { anchorOf, MenuPortal, type MenuAnchor } from "@/components/flow/clean/menus/MenuPortal";
import { computeCommunityPlanStats } from "@/lib/community/plan-stats";
import { useLibraryTab } from "@/lib/library/library-tab";
import type { EntryIcon } from "@/lib/model/types";
import { useWelcomeTab } from "@/lib/welcome/welcome-tab";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

export function PlanIdentityStrip() {
  const library = useLibraryTab();
  const welcome = useWelcomeTab();
  const designId = useDesignStore((state) => state.activeDesignId);
  const publicView = useDesignStore((state) => state.publicView);
  const readOnly = useFactoryStore((state) => state.isReadOnly);
  const taskBoard = useFactoryStore((state) => state.project.primaryView === "tasks");
  if (!designId || publicView || readOnly || taskBoard || library.active || welcome.active) return null;
  return <PlanIdentity key={designId} designId={designId} />;
}

function PlanIdentity({ designId }: { designId: string }) {
  const name = useFactoryStore((state) => state.project.name);
  const description = useFactoryStore((state) => state.project.description);
  const icon = useFactoryStore((state) => state.project.icon);
  const update = useDesignStore((state) => state.updateDesignIdentity);
  const [suggestions, setSuggestions] = useState<EntryIcon[]>();
  const [editor, setEditor] = useState<{ field: "name" | "description"; anchor: MenuAnchor }>();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const closeEditor = () => { if (!saving) setEditor(undefined); };

  const edit = (field: "name" | "description", element: HTMLElement) => {
    setProblem(undefined);
    setDraft(field === "name" ? name : description ?? "");
    setEditor({ field, anchor: anchorOf(element) });
  };
  const pickIcon = () => {
    const { project, lastResult } = useFactoryStore.getState();
    const stats = computeCommunityPlanStats(project, lastResult);
    const recipeIds = new Set(project.nodes.flatMap((node) =>
      [node.recipeId, ...(node.extraRecipes ?? []).map((section) => section.recipeId)]));
    const buildResources = project.recipes
      .filter((recipe) => recipeIds.has(recipe.id))
      .flatMap((recipe) => [...recipe.outputs, ...recipe.inputs])
      .filter((resource) => resource.kind === "item" || resource.kind === "fluid")
      .map((resource) => ({ ...resource, resourceId: resource.id }));
    setProblem(undefined);
    setSuggestions(iconSuggestionsFromStats([...stats.needs, ...buildResources], stats.outputs));
  };
  const saveIcon = (entry: EntryIcon | null) => {
    setSuggestions(undefined);
    void update(designId, { icon: entry }).catch(() => setProblem("Could not save the plan icon."));
  };
  const saveDetails = async () => {
    if (!editor || saving || (editor.field === "name" && !draft.trim())) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await update(designId, { [editor.field]: draft.trim() });
      setEditor(undefined);
    } catch {
      setProblem("Could not save the plan details.");
    } finally {
      setSaving(false);
    }
  };
  const fieldLabel = editor?.field === "name" ? "Plan title" : "Plan description";

  return (
    <section className="plan-identity" aria-label="Plan details" data-plan-identity="">
      <EntryIconSlot icon={icon} editable onEdit={pickIcon} className="!h-5 !w-5 plan-identity-icon" />
      <button
        type="button"
        className="plan-identity-title"
        aria-label="Edit plan title"
        aria-haspopup="dialog"
        aria-expanded={editor?.field === "name"}
        data-menu-anchor=""
        onClick={(event) => edit("name", event.currentTarget)}
      >
        {name}
      </button>
      <button
        type="button"
        className="plan-identity-description"
        aria-label="Edit plan description"
        aria-haspopup="dialog"
        aria-expanded={editor?.field === "description"}
        data-menu-anchor=""
        onClick={(event) => edit("description", event.currentTarget)}
      >
        {description?.trim() || "Add a description"}
      </button>
      {problem && !editor ? <span className="plan-identity-error" role="alert">{problem}</span> : null}
      {editor ? (
        <MenuPortal anchor={editor.anchor} width={320} maxHeight={280} role="dialog" label={fieldLabel} onClose={closeEditor}>
          <form
            className="cm-scroll plan-identity-form"
            onSubmit={(event) => { event.preventDefault(); void saveDetails(); }}
          >
            <label>
              {fieldLabel}
              {editor.field === "name" ? (
                <input aria-label={fieldLabel} maxLength={80} value={draft} onChange={(event) => setDraft(event.target.value)} />
              ) : (
                <textarea aria-label={fieldLabel} rows={4} maxLength={2000} value={draft} onChange={(event) => setDraft(event.target.value)} />
              )}
            </label>
            {problem ? <span className="plan-identity-error" role="alert">{problem}</span> : null}
            <div className="plan-identity-actions">
              <button type="button" className="cm-compare-key" disabled={saving} onClick={closeEditor}>Cancel</button>
              <button type="submit" className="cm-compare-key" disabled={saving || (editor.field === "name" && !draft.trim())}>Save</button>
            </div>
          </form>
        </MenuPortal>
      ) : null}
      {suggestions ? (
        <IconPicker
          title="Pick this plan’s icon"
          suggestions={suggestions}
          onPick={saveIcon}
          onClear={icon ? () => saveIcon(null) : undefined}
          onClose={() => setSuggestions(undefined)}
        />
      ) : null}
    </section>
  );
}
