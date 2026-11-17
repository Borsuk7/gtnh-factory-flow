import { availableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { CommunityPlanStats } from "@/lib/community/types";
import type { FactoryProject } from "@/lib/model/types";

export class CommunityStatsBusy extends Error {}

interface Job {
  project: FactoryProject;
  resolve: (stats: CommunityPlanStats) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
}

const MAX_WORKERS = Math.min(2, availableParallelism());
const MAX_WAITING = 16;
const jobs: Job[] = [];
const slots = new Set<Slot>();
const refreshes = new Map<string, Promise<CommunityPlanStats>>();

export function solveCommunityStats(project: FactoryProject, refreshKey?: string): Promise<CommunityPlanStats> {
  if (refreshKey !== undefined) {
    const pending = refreshes.get(refreshKey);
    if (pending) return pending;
  }
  if (jobs.length >= MAX_WAITING) {
    return Promise.reject(new CommunityStatsBusy("Plan stats are busy. Try again shortly."));
  }
  const request = new Promise<CommunityPlanStats>((resolve, reject) => {
    jobs.push({ project, resolve, reject });
    dispatch();
  });
  if (refreshKey === undefined) return request;
  const refresh = request.finally(() => refreshes.delete(refreshKey));
  refreshes.set(refreshKey, refresh);
  return refresh;
}

function dispatch() {
  while (jobs.length) {
    let slot = [...slots].find((entry) => !entry.job);
    if (!slot && slots.size >= MAX_WORKERS) return;
    const job = jobs.shift()!;
    try {
      slot ??= spawnWorker();
      slot.job = job;
      slot.worker.ref();
      slot.worker.postMessage(job.project);
    } catch (error) {
      if (slot) {
        slot.job = undefined;
        slot.worker.unref();
      }
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function spawnWorker(): Slot {
  const worker = new Worker(path.join(process.cwd(), "dist-server", "community-stats.cjs"));
  const slot: Slot = { worker };
  slots.add(slot);
  worker.on("message", (answer: { stats?: CommunityPlanStats; error?: string }) => {
    const job = slot.job;
    slot.job = undefined;
    worker.unref();
    if (answer.stats) job?.resolve(answer.stats);
    else job?.reject(new Error(answer.error ?? "The plan stats could not be calculated."));
    dispatch();
  });
  const loseWorker = (error: Error) => {
    if (!slots.delete(slot)) return;
    slot.job?.reject(error);
    dispatch();
  };
  worker.on("error", loseWorker);
  worker.on("exit", (code) => loseWorker(new Error(`Plan stats worker exited with code ${code}.`)));
  return slot;
}
