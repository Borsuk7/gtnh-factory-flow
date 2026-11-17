"use client";

import "./chrome.css";
import "./settings.css";
import "./screenshot.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toBlob, toSvg } from "html-to-image";
import { computeScreenshotPlanStats } from "@/lib/community/plan-stats";
import { serializeFactoryProject } from "@/lib/import-export";
import {
  FLOW_IMAGE_EXPORT_COMPLETE_EVENT,
  FLOW_IMAGE_EXPORT_EVENT,
  dataUrlToText,
  embedProjectJsonInPng,
  embedProjectJsonInPngMetadata,
  embedProjectJsonInSvg,
  type FlowExportCapture,
  type FlowExportRequest,
} from "@/lib/import-export/plan-image";
import { resolveExportFontCss } from "@/lib/import-export/export-fonts";
import { composeExportSvg, compositeExportPng, computeCompositeLayout } from "@/lib/import-export/export-composite";
import { randomUUID } from "@/lib/random-id";
import { activateOnKey } from "@/lib/hooks/button-keys";
import { playBoardSound } from "@/lib/board-sounds";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { ExportFooter, resolveExportFooterWidth } from "@/components/export/ExportFooter";
import { gifExportScale, renderPlanGif } from "@/components/export/gif-export";

type Detail = "full" | "glance";
const FORMATS = ["png", "svg", "gif"] as const;
type ImageFormat = (typeof FORMATS)[number];
const DETAILS: ReadonlyArray<{ id: Detail; label: string }> = [
  { id: "full", label: "Detailed" },
  { id: "glance", label: "Simple" },
];

/** What was chosen last, kept while the page is open (the mod keeps it while the game runs). */
let chosen = {
  format: "png" as ImageFormat,
  detail: "full" as Detail,
  title: false,
  io: false,
  transparent: false,
  showAnnotations: true,
  embedPlan: true,
};

interface CaptureResult {
  capture?: FlowExportCapture;
  error?: string;
}

/** The mark every picture carries when the footer (which has its own) is off. */
const MARK = "GTNH Planner";

/**
 * The Share key's Screenshot (the mod's ScreenshotPanel): a picture of the open plan shown as it will come out, the
 * box nearly the screen's size. On the left the picture; on the right how much the cards show (Detailed, or Simple:
 * the zoomed-out look), whether a footer gives the plan's name, and what goes in and out, its size, and Copy and Save.
 * By default it is the plan and nothing else, with the small mark every picture carries.
 */
export function ModScreenshot({ onClose }: { onClose: () => void }) {
  const project = useFactoryStore((state) => state.project);
  const result = useFactoryStore((state) => state.lastResult);
  const activeTabName = useDesignStore(
    (state) => state.designs.find((design) => design.id === state.activeDesignId)?.name ?? "Untitled",
  );
  const rateUnit = useFactoryStore((state) => state.rateUnit);
  const [format, setFormat] = useState(chosen.format);
  const [detail, setDetail] = useState<Detail>(chosen.detail);
  const [title, setTitle] = useState(chosen.title);
  const [io, setIo] = useState(chosen.io);
  const [transparent, setTransparent] = useState(chosen.transparent);
  const [showAnnotations, setShowAnnotations] = useState(chosen.showAnnotations);
  const [embedPlan, setEmbedPlan] = useState(chosen.embedPlan);
  const [taken, setTaken] = useState<{ key: string; capture?: FlowExportCapture; problem?: string }>();
  const [status, setStatus] = useState<{ text: string; good: boolean }>();
  const [keeping, setKeeping] = useState(false);
  const planName = project.name || activeTabName || "My factory";

  useEffect(() => {
    chosen = { format, detail, title, io, transparent, showAnnotations, embedPlan };
  }, [format, detail, title, io, transparent, showAnnotations, embedPlan]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const stats = useMemo(
    () => computeScreenshotPlanStats(project, result),
    [project, result],
  );

  // ---- Asking the board for its photograph ---------------------------------

  const pendingRef = useRef(new Map<string, (result: CaptureResult) => void>());
  useEffect(() => {
    const handleComplete = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { requestId?: unknown; capture?: FlowExportCapture; error?: unknown }
        | undefined;
      if (typeof detail?.requestId !== "string") return;
      const resolve = pendingRef.current.get(detail.requestId);
      if (resolve) {
        pendingRef.current.delete(detail.requestId);
        resolve({ capture: detail.capture, error: typeof detail.error === "string" ? detail.error : undefined });
      }
    };
    window.addEventListener(FLOW_IMAGE_EXPORT_COMPLETE_EVENT, handleComplete);
    return () => window.removeEventListener(FLOW_IMAGE_EXPORT_COMPLETE_EVENT, handleComplete);
  }, []);

  const requestBoardCapture = useCallback(
    (format: FlowExportRequest["format"], options: Pick<FlowExportRequest, "cardDetail" | "background" | "hideAnnotations" | "animateWires">) =>
      new Promise<CaptureResult>((resolve) => {
        const requestId = randomUUID();
        pendingRef.current.set(requestId, resolve);
        window.dispatchEvent(
          new CustomEvent(FLOW_IMAGE_EXPORT_EVENT, {
            detail: { format, requestId, capture: true, ...options },
          }),
        );
        window.setTimeout(() => {
          if (pendingRef.current.delete(requestId)) resolve({ error: "Timed out photographing the board." });
        }, 120_000);
      }),
    [],
  );

  const animateWires = format === "gif";
  const captureOptions = useMemo(() => ({
    cardDetail: detail,
    background: transparent ? "transparent" : undefined,
    hideAnnotations: !showAnnotations,
    animateWires,
  }), [detail, transparent, showAnnotations, animateWires]);
  const wantKey = `${detail}|${rateUnit}|${transparent}|${showAnnotations}|${animateWires}`;
  const capturing = taken?.key !== wantKey;
  const capture = taken?.capture;
  const problem = taken?.key === wantKey ? taken.problem : undefined;
  useEffect(() => {
    let cancelled = false;
    const attempt = (retriesLeft: number) => {
      void requestBoardCapture("png", captureOptions).then((outcome) => {
        if (cancelled) return;
        if (!outcome.capture?.blob) {
          if (retriesLeft > 0) {
            window.setTimeout(() => !cancelled && attempt(retriesLeft - 1), 700);
            return;
          }
          setTaken({ key: wantKey, problem: outcome.error ?? "The board could not be captured." });
          return;
        }
        setTaken({ key: wantKey, capture: outcome.capture });
      });
    };
    const frame = requestAnimationFrame(() => attempt(2));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // The rate unit repaints the board, not the request: the photograph is taken again.
  }, [requestBoardCapture, captureOptions, wantKey]);

  const previewUrl = useMemo(() => (capture?.blob ? URL.createObjectURL(capture.blob) : undefined), [capture]);
  useEffect(() => () => (previewUrl ? URL.revokeObjectURL(previewUrl) : undefined), [previewUrl]);

  // ---- Measuring the pieces the composite needs ----------------------------

  const wellRef = useRef<HTMLDivElement>(null);
  const [well, setWell] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = wellRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWell({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const [footerElement, setFooterElement] = useState<HTMLDivElement | null>(null);
  const [measuredFooter, setFooterHeight] = useState(0);
  const footerHeight = footerElement ? measuredFooter : 0;
  useEffect(() => {
    if (!footerElement || typeof ResizeObserver === "undefined") return;
    // Observing reports the first size at once.
    const observer = new ResizeObserver(() => setFooterHeight(footerElement.offsetHeight));
    observer.observe(footerElement);
    return () => observer.disconnect();
  }, [footerElement]);

  const footerVisible = title || (io && (stats.needs.length > 0 || stats.outputs.length > 0));
  const footerWidth = capture ? resolveExportFooterWidth(capture.width) : 0;
  const layout = useMemo(
    () =>
      capture
        ? computeCompositeLayout(capture.width, capture.height, footerVisible ? footerWidth : 0, footerVisible ? footerHeight : 0)
        : undefined,
    [capture, footerVisible, footerWidth, footerHeight],
  );
  // The WHOLE image contain-fit in the well; the mod's preview is one pixel of it to a pixel of the screen.
  const scale =
    capture && layout && well.width > 8 && well.height > 8
      ? Math.min((well.width - 8) / capture.width, (well.height - 8) / layout.totalHeight)
      : 0;
  const imageScale = capture && layout ? (format === "gif" ? gifExportScale(layout) : format === "svg" ? 1 : capture.pixelRatio) : 1;
  const pixels = layout
    ? `${Math.round(layout.boardWidth * imageScale).toLocaleString("en-US")} x ${Math.round(layout.totalHeight * imageScale).toLocaleString("en-US")} pixels`
    : undefined;

  // ---- The picture itself --------------------------------------------------

  const compose = async (output: ImageFormat, includePlan: boolean): Promise<Blob> => {
    if (!capture?.blob || !layout) throw new Error("The board capture is missing.");
    const footer = footerVisible && layout.footerHeight > 0 ? footerElement : null;
    const footerOptions = footer ? {
      width: layout.footerWidth,
      height: layout.footerHeight,
      pixelRatio: layout.footerScale * capture.pixelRatio,
      skipFonts: true,
      fontEmbedCSS: await resolveExportFontCss(footer),
    } : undefined;
    if (output === "svg") {
      const { capture: svgCapture, error } = await requestBoardCapture("svg", captureOptions);
      if (!svgCapture?.svgText) throw new Error(error ?? "The board could not be rendered as SVG.");
      const footerSvg = footer ? dataUrlToText(await toSvg(footer, footerOptions)) : undefined;
      const svgLayout = computeCompositeLayout(svgCapture.width, svgCapture.height, layout.footerWidth, layout.footerHeight);
      const svg = composeExportSvg({
        boardSvg: svgCapture.svgText,
        footerSvg,
        layout: svgLayout,
        background: svgCapture.background,
        mark: footerSvg ? undefined : MARK,
      });
      const content = includePlan ? embedProjectJsonInSvg(svg, serializeFactoryProject(project)) : svg;
      return new Blob([content], { type: "image/svg+xml" });
    }
    const footerBlob = footer ? (await toBlob(footer, footerOptions)) ?? undefined : undefined;
    if (output === "gif") {
      return renderPlanGif({
        boardBlob: footerBlob ? capture.blob : await stampMark(capture.blob, capture.pixelRatio),
        footerBlob,
        layout,
        capture,
        background: capture.background,
        onProgress: (frame, total) => setStatus({ text: `Rendering frame ${frame} of ${total}`, good: true }),
      });
    }
    const composed = await compositeExportPng({
      boardBlob: capture.blob,
      footerBlob,
      layout,
      pixelRatio: capture.pixelRatio,
    });
    const marked = footerBlob ? composed : await stampMark(composed, capture.pixelRatio);
    if (!includePlan) return marked;
    const projectJson = serializeFactoryProject(project);
    return transparent
      ? embedProjectJsonInPngMetadata(marked, projectJson)
      : embedProjectJsonInPng(marked, projectJson);
  };

  const save = async () => {
    if (!capture || keeping) return;
    setKeeping(true);
    setStatus(undefined);
    try {
      const blob = await compose(format, embedPlan);
      const name = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "factory"}.${format}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus({ text: `Saved as ${name}`, good: true });
      playBoardSound("tick");
    } catch (error) {
      setStatus({ text: `Couldn't save it: ${error instanceof Error ? error.message : "failed"}`, good: false });
    } finally {
      setKeeping(false);
    }
  };

  const copy = async () => {
    if (!capture || keeping) return;
    setKeeping(true);
    setStatus(undefined);
    try {
      // Clipboard PNGs can lose metadata. The opaque export has a pixel fallback.
      const blob = await compose("png", embedPlan && !transparent);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus({ text: "Copied: paste it anywhere", good: true });
      playBoardSound("tick");
    } catch (error) {
      setStatus({ text: `Couldn't copy it: ${error instanceof Error ? error.message : "failed"}`, good: false });
    } finally {
      setKeeping(false);
    }
  };

  const ready = Boolean(capture) && !capturing && !keeping;

  return createPortal(
    <div
      className="ms-backdrop ui-zoom"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mx mshot" role="dialog" aria-modal="true" aria-label="Screenshot" data-mod-screenshot="">
        <div className="mshot-title">
          <span>Screenshot</span>
          <div className="ms-close" role="button" aria-label="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden fill="currentColor">
              <path d={crossPath()} />
            </svg>
          </div>
        </div>
        <div className="mshot-body">
          <div ref={wellRef} className="mshot-well">
            {previewUrl && capture && scale > 0 ? (
              <div
                className="mshot-picture"
                data-transparent={transparent && !capturing ? "" : undefined}
                style={{ width: capture.width * scale }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="Plan picture preview" draggable={false} />
                {footerVisible && layout ? (
                  <div style={{ height: layout.footerHeight * layout.footerScale * scale, overflow: "hidden" }}>
                    <div
                      style={{
                        width: layout.footerWidth,
                        transform: `scale(${layout.footerScale * scale})`,
                        transformOrigin: "top left",
                      }}
                    >
                      <div ref={setFooterElement}>
                        <ExportFooter
                          planName={planName}
                          icon={project.icon}
                          stats={stats}
                          tone="dark"
                          width={layout.footerWidth}
                          showTitle={title}
                          showIo={io}
                          needs={stats.needs}
                          outputs={stats.outputs}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className="mshot-mark">{MARK}</span>
                )}
              </div>
            ) : null}
            {capturing ? <div className="mshot-note">Taking the picture...</div> : null}
            {problem && !capturing ? <div className="mshot-note" data-bad="">{problem}</div> : null}
          </div>
          <div className="mshot-col">
            <div className="mshot-row">
              <span>Format</span>
              <span className="ms-choices" role="radiogroup" aria-label="Format">
                {FORMATS.map((value) => (
                  <label key={value} className="ms-choice" data-picked={format === value ? "" : undefined}>
                    <input
                      className="sr-only"
                      type="radio"
                      name="screenshot-format"
                      checked={format === value}
                      disabled={keeping}
                      onChange={() => {
                        setFormat(value);
                        setStatus(undefined);
                        playBoardSound("tick");
                      }}
                    />
                    {value.toUpperCase()}
                  </label>
                ))}
              </span>
            </div>
            <div className="mshot-row">
              <span>Cards</span>
              <span className="ms-choices" role="radiogroup" aria-label="Cards">
                {DETAILS.map((entry) => (
                  <span
                    key={entry.id}
                    role="radio"
                    aria-checked={detail === entry.id}
                    className="ms-choice"
                    data-picked={detail === entry.id ? "" : undefined}
                    onClick={() => {
                      if (detail !== entry.id) {
                        setDetail(entry.id);
                        playBoardSound("tick");
                      }
                    }}
                  >
                    {entry.label}
                  </span>
                ))}
              </span>
            </div>
            <Toggle label="Plan name" on={title} onChange={setTitle} />
            <Toggle label="Inputs and outputs" on={io} onChange={setIo} />
            <Toggle label="Transparent background" on={transparent} onChange={setTransparent} />
            <Toggle label="Show annotations" on={showAnnotations} onChange={setShowAnnotations} />
            {format !== "gif" ? <Toggle label="Embed plan" on={embedPlan} onChange={setEmbedPlan} /> : null}
            {format !== "gif" && embedPlan && !showAnnotations ? (
              <div className="mshot-hint">The embedded plan includes annotations.</div>
            ) : null}
            {format === "png" && embedPlan && transparent ? (
              <div className="mshot-hint">Use Save to embed the plan in a transparent PNG.</div>
            ) : null}
            {format === "gif" ? (
              <div className="mshot-hint">Wires carrying material animate in the saved GIF.</div>
            ) : null}
            <div className="mshot-size">{pixels ?? "Taking the picture..."}</div>
            {status ? (
              <div className="mshot-status" role="status" data-good={status.good ? "" : undefined}>
                {status.text}
              </div>
            ) : null}
            <div className="mshot-keys">
              {format === "png" ? (
                <div
                  className="mb-key mshot-key"
                  role="button"
                  tabIndex={0}
                  aria-disabled={!ready}
                  data-off={ready ? undefined : ""}
                  onKeyDown={activateOnKey}
                  onClick={() => ready && void copy()}
                >
                  Copy
                </div>
              ) : null}
              <div
                className="mb-key mshot-key"
                data-save=""
                role="button"
                tabIndex={0}
                aria-disabled={!ready}
                data-off={ready ? undefined : ""}
                onKeyDown={activateOnKey}
                onClick={() => ready && void save()}
              >
                Save
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (next: boolean) => void }) {
  return (
    <div
      className="mshot-row"
      role="switch"
      tabIndex={0}
      aria-checked={on}
      aria-label={label}
      onKeyDown={activateOnKey}
      onClick={() => {
        onChange(!on);
        playBoardSound("tick", { gain: on ? 0.9 : 1.1 });
      }}
    >
      <span>{label}</span>
      <span className="ms-switch" data-on={on ? "" : undefined}>
        <span className="ms-knob" />
      </span>
    </div>
  );
}

function crossPath(): string {
  const d: string[] = [];
  for (let k = -3; k <= 3; k++) {
    d.push(`M${6.5 + k} ${6.5 + k}h1v1h-1z`, `M${6.5 + k} ${6.5 - k}h1v1h-1z`);
  }
  return d.join("");
}

/** A small cyan "GTNH Planner" at the picture's bottom right, the mark every picture carries. */
async function stampMark(blob: Blob, pixelRatio: number): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const size = Math.max(10, Math.round(11 * pixelRatio));
    const family = getComputedStyle(document.body).getPropertyValue("--font-minecraft").trim() || "monospace";
    context.font = `${size}px ${family}, monospace`;
    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.fillStyle = "#22d3ee";
    context.fillText(MARK, canvas.width - Math.round(8 * pixelRatio), canvas.height - Math.round(6 * pixelRatio));
    return await new Promise<Blob>((resolve) => canvas.toBlob((out) => resolve(out ?? blob), "image/png"));
  } catch {
    return blob;
  }
}
