import { initLpEngine } from "@/lib/solver/lp-engine";
import type { FactoryProject } from "@/lib/model/types";

/**
 * Stats are derived on the server from the uploaded plan (`calculateThroughput`).
 * A plan-mode plan solves integer programs, which only HiGHS can do, so the
 * stats worker loads it first (a no-op for every other plan and after the first
 * load). If it cannot load the solve fails honestly and the stats are the
 * failed plan's, never an error page.
 */
export async function ensurePlanEngine(project: Pick<FactoryProject, "planMode">): Promise<void> {
  if (project.planMode) {
    await initLpEngine();
  }
}
