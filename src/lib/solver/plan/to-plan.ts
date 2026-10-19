import type { FactoryProject } from "../../model/types";
import { convertBuildToPlanWithReport, type PlanConversionReport } from "./convert";
import { wirePoolProject, type PoolConversionReport } from "./pool-to-plan";

/** Which of the old modes a plan was in when it arrived. */
export type PlanOrigin = "build" | "solve" | "pool";

/**
 * Said to the player once, when a conversion could not carry everything over.
 * A plain Build or Solve plan converts without a word; a Pool plan always
 * gets one, because its pools turned into wires. `plan`: a plan already in the
 * one mode whose loose cell wires became fluid tanks (`model/project-normalize.ts`).
 */
export interface PlanConversionNotice {
  origin: PlanOrigin | "plan";
  text: string;
  /** Short lines for the parts that did not come over. */
  details: string[];
}

export interface PlanOpening {
  project: FactoryProject;
  /** Unset when the plan was already a plan-mode project. */
  origin?: PlanOrigin;
  report?: PlanConversionReport;
  pool?: PoolConversionReport;
  notice?: PlanConversionNotice;
}

/**
 * THE funnel to the one mode. Every project that arrives (the design library,
 * account sync, a community post, a plan link, JSON, a blueprint, a shared
 * setup, a new design) passes through here, and what comes out is a plan-mode
 * project: Build plans by `convertBuildToPlan`, Solve plans likewise with their
 * pins and drawer rules kept live, Pool plans wired per resource first.
 *
 * Pure: the input is never changed. A project already in plan mode comes back
 * as the same object, so loading is idempotent and costs nothing.
 *
 * The result is only a view until the player edits: loads never write, and the
 * first edit saves the converted plan (which carries `planMode` and
 * `solveMode`, so an older build opens it as Solve).
 */
export function openAsPlan(project: FactoryProject): PlanOpening {
  if (project.planMode) {
    return { project };
  }
  if (project.poolMode) {
    const wired = wirePoolProject(project);
    const converted = convertBuildToPlanWithReport(wired.project);
    const details: string[] = [];
    if (wired.report.groups > 0) details.push("Groups are gone.");
    if (wired.report.rules > 0) details.push("Share and Outside supply switches are gone.");
    if (wired.report.duplicateDrawers.length > 0) {
      details.push("Drawers of one resource on the same side were joined.");
    }
    if (wired.report.unreachedDrawers > 0) details.push("Some drawers have nothing to wire to.");
    if (wired.report.bridgeWires > 0) details.push("Cells and their fluids meet in fluid tanks.");
    if (converted.report.droppedTargets.length > 0) details.push("A target that no card makes was dropped.");
    return {
      project: converted.project,
      origin: "pool",
      report: converted.report,
      pool: wired.report,
      notice: {
        origin: "pool",
        text: "Converted from a pool plan. Every maker is now wired to every user of its resource.",
        details,
      },
    };
  }
  const converted = convertBuildToPlanWithReport(project);
  const origin: PlanOrigin = project.solveMode ? "solve" : "build";
  const report = converted.report;
  // Said every time: what came over and what did not, in one line.
  const details: string[] = [];
  const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (origin === "build" && report.pinned > 0) {
    details.push(`${plural(report.pinned, "card")} set to up to ${report.pinned === 1 ? "its count" : "their counts"}.`);
  }
  if (report.portRates > 0) {
    details.push(`${plural(report.portRates, "rate")} set from ${report.portRates === 1 ? "a target" : "targets"}.`);
  }
  if (report.drawerRatesParked > 0) {
    details.push(`${plural(report.drawerRatesParked, "drawer rate")} set to Ignore.`);
  }
  if (report.unanchored) details.push("Nothing is set yet. Pin a count or set a rate.");
  if (origin === "solve" && !report.unanchored && !report.seededFromTargets) details.push("Pins and drawer rates kept.");
  const dropped: string[] = [];
  if (report.ratioBuffersFlattened > 0) dropped.push(plural(report.ratioBuffersFlattened, "ratio buffer"));
  if (report.droppedTargets.length > 0) dropped.push(plural(report.droppedTargets.length, "target") + " no card makes");
  if (dropped.length > 0) details.push(`Dropped: ${dropped.join(", ")}.`);
  return {
    project: converted.project,
    origin,
    report,
    // An empty board has nothing to say (every new design starts as one).
    notice:
      project.nodes.length === 0 && (project.storages ?? []).length === 0
        ? undefined
        : { origin, text: `Converted from a ${origin === "solve" ? "Solve" : "Build"} plan.`, details },
  };
}

/** The project alone, for callers that have no use for the report. */
export function toPlanProject(project: FactoryProject): FactoryProject {
  return openAsPlan(project).project;
}
