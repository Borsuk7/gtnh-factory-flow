"use client";

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { AnnotationNode, type AnnotationFlowNode } from "../../AnnotationNode";
import { useFactoryStore } from "@/store/factory-store";
import { CleanDrawing } from "./CleanDrawing";
import { StickyNote, type StickyNoteFlowNode } from "./StickyNote";

/**
 * What FactoryFlow registers as `annotationNode`: on a plan board (`project.planMode`) a text annotation is a
 * sticky note and a box, zone or arrow uses `CleanDrawing`. Images reuse the resizable annotation frame.
 */
function AnnotationSwitchComponent(props: NodeProps<AnnotationFlowNode>) {
  const planMode = useFactoryStore((state) => state.project.planMode === true);
  if (planMode && props.data.annotation.kind === "text") {
    return <StickyNote {...(props as unknown as NodeProps<StickyNoteFlowNode>)} />;
  }
  if (planMode && props.data.annotation.kind !== "image") {
    return <CleanDrawing {...props} />;
  }
  return <AnnotationNode {...props} />;
}

export const AnnotationSwitch = memo(AnnotationSwitchComponent);
