"use client";

import { Pencil } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EntryIconSlot, IconPicker, iconSuggestionsFromProject } from "@/components/IconPicker";
import { readDesign } from "@/lib/designs/design-storage";
import type { EntryIcon, FactoryProject } from "@/lib/model/types";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

type Identity = Pick<FactoryProject, "name" | "description" | "icon">;
type IdentityPatch = Parameters<ReturnType<typeof useDesignStore.getState>["updateDesignIdentity"]>[1];

export function PlanIdentityStrip() {
  const designId = useDesignStore((state) => state.activeDesignId);
  const publicView = useDesignStore((state) => state.publicView);
  const readOnly = useFactoryStore((state) => state.isReadOnly);
  if (!designId || publicView || readOnly) return null;
  return <ActivePlanIdentity key={designId} designId={designId} />;
}

function ActivePlanIdentity({ designId }: { designId: string }) {
  const name = useFactoryStore((state) => state.project.name);
  const description = useFactoryStore((state) => state.project.description);
  const icon = useFactoryStore((state) => state.project.icon);
  return (
    <PlanIdentityFields
      designId={designId}
      identity={{ name, description, icon }}
      getProject={() => useFactoryStore.getState().project}
    />
  );
}

export function ListedPlanIdentity({ designId }: { designId: string }) {
  const isActive = useDesignStore((state) => state.activeDesignId === designId);
  return isActive
    ? <ActivePlanIdentity designId={designId} />
    : <StoredPlanIdentity designId={designId} />;
}

export function PlanDetailsButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="mb-key ml-tile-edit"
      aria-label={`Edit details for ${name}`}
      title="Edit title, description, and icon"
      onClick={onClick}
    >
      <Pencil size={11} aria-hidden />
    </button>
  );
}

function StoredPlanIdentity({ designId }: { designId: string }) {
  const [project, setProject] = useState<FactoryProject>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void readDesign(designId).then((record) => {
      if (!cancelled) setProject(record?.project);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [designId]);

  if (!project) {
    return <p role="status">{loading ? "Loading plan details…" : "Could not load the plan details."}</p>;
  }
  return (
    <PlanIdentityFields
      designId={designId}
      identity={project}
      getProject={() => project}
      onSaved={({ icon, ...text }) => setProject((current) => current && ({
        ...current,
        ...text,
        ...(icon !== undefined ? { icon: icon ?? undefined } : {}),
      }))}
    />
  );
}

function PlanIdentityFields({
  designId,
  identity,
  getProject,
  onSaved,
}: {
  designId: string;
  identity: Identity;
  getProject: () => FactoryProject;
  onSaved?: (patch: IdentityPatch) => void;
}) {
  const [suggestions, setSuggestions] = useState<EntryIcon[]>();
  const [problem, setProblem] = useState<string>();
  const queue = useRef(Promise.resolve());
  const update = useDesignStore((state) => state.updateDesignIdentity);
  const save = (patch: IdentityPatch) => {
    setProblem(undefined);
    const pending = queue.current.then(async () => {
      await update(designId, patch);
      onSaved?.(patch);
    });
    queue.current = pending.catch(() => undefined);
    return pending;
  };
  const saveIcon = (icon: EntryIcon | null) => {
    setSuggestions(undefined);
    void save({ icon }).catch(() => setProblem("Could not save the plan icon."));
  };

  return (
    <section className="plan-identity" aria-label="Plan details" data-plan-identity="">
      <EntryIconSlot
        icon={identity.icon}
        editable
        onEdit={() => setSuggestions(iconSuggestionsFromProject(getProject()))}
        className="!h-5 !w-5 plan-identity-icon"
      />
      <IdentityField field="name" value={identity.name} onSave={(name) => save({ name })} />
      <IdentityField
        field="description"
        value={identity.description ?? ""}
        onSave={(description) => save({ description })}
      />
      {problem ? <span className="plan-identity-error" role="alert">{problem}</span> : null}
      {suggestions ? (
        <IconPicker
          portaled
          title="Pick this plan’s icon"
          suggestions={suggestions}
          onPick={saveIcon}
          onClear={identity.icon ? () => saveIcon(null) : undefined}
          onClose={() => setSuggestions(undefined)}
        />
      ) : null}
    </section>
  );
}

function IdentityField({ field, value, onSave }: {
  field: "name" | "description";
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const title = field === "name";
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = useRef(false);
  const onBlur = (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    if (saving) {
      cancel.current = false;
      return;
    }
    const next = event.currentTarget.value.trim();
    if (cancel.current || next === value || (title && !next)) {
      cancel.current = false;
      setDraft(undefined);
      return;
    }
    setSaving(true);
    void onSave(next).then(() => setDraft(undefined), () => setFailed(true)).finally(() => setSaving(false));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      cancel.current = true;
      setFailed(false);
    } else if (event.key !== "Enter" || (!title && event.shiftKey)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  };
  const props = {
    "aria-label": title ? "Plan title" : "Plan description",
    "aria-invalid": failed || undefined,
    className: title ? "plan-identity-title" : "plan-identity-description",
    value: draft ?? value,
    maxLength: title ? 80 : 2000,
    readOnly: saving,
    onBlur,
    onKeyDown,
    onChange: (event: { target: HTMLInputElement | HTMLTextAreaElement }) => {
      setFailed(false);
      setDraft(event.target.value);
    },
  };
  return (
    <>
      {title ? <input {...props} /> : (
        <div className="plan-identity-description-slot">
          <textarea {...props} rows={1} placeholder="Add a description" />
        </div>
      )}
      {failed ? <span className="plan-identity-error" role="alert">Could not save the plan {title ? "title" : "description"}.</span> : null}
    </>
  );
}
