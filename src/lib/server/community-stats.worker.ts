import { parentPort } from "node:worker_threads";
import { computeCommunityPlanStats } from "@/lib/community/plan-stats";
import { normalizeLoadedProject } from "@/lib/model/project-normalize";
import type { FactoryProject } from "@/lib/model/types";
import { calculateThroughput } from "@/lib/solver";
import { ensurePlanEngine } from "./plan-engine";

const port = parentPort;
if (!port) throw new Error("Community stats require a worker thread.");

port.on("message", async (source: FactoryProject) => {
  try {
    const project = normalizeLoadedProject(source);
    await ensurePlanEngine(project);
    port.postMessage({ stats: computeCommunityPlanStats(project, calculateThroughput(project)) });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
