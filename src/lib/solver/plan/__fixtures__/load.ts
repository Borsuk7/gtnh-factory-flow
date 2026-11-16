/**
 * Corpus loader for the plan-mode solver tests. See corpus/README.md for the file format.
 *
 * Reads `corpus/inputs/<name>.json` (the mod's `SolveInputJson` dumps) into a `SolveInput`, `corpus/goldens/<name>.json`
 * into a digest, and builds the two tiled cases (`platline-x4`, `platline-x10`) the way the mod's `SolverCorpus.tile`
 * does. Node-only (uses fs and crypto); never import this from app code.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { DrawerIn, EdgeIn, Id, MachineIn, PoolIn, PortIn, SolveInput } from "./types-local";

const CORPUS_DIR = path.join(__dirname, "corpus");

/** The 14 plans dumped from the game. */
export const PLAN_NAMES = [
  "single-card-v2",
  "benzene",
  "oxygen-silicon-loop",
  "titanium-line-tour",
  "pa-cell-loop",
  "hv-diesel",
  "sulfuric-acid",
  "titanium-line-chembath",
  "glass",
  "alumina-line-shared-reactor",
  "mega-iv-nitrobenzene-power-plant",
  "mv",
  "full-platline",
  "platline",
  "buffer-drawers",
] as const;

/** The 16 gtnh-flow charts (`GtnhFlowLoader.CORPUS`); case names are `gtnh-flow-<chart>`. */
export const CHART_NAMES = [
  "mk1",
  "mk1_tiberium",
  "loopGraph",
  "light_fuel",
  "light_fuel_hydrogen_loop",
  "230_platline",
  "palladium_line",
  "nanocircuits",
  "cetane",
  "jet_fuel",
  "microsheep",
  "palladium",
  "twoslack",
  "excess_choice",
  "symmetric_choice",
  "two_decisions",
] as const;

/** Tiled cases: name -> copies of `platline`. `platline-x10` is tagged `bench` in the mod. */
export const TILED_CASES: Record<string, number> = { "platline-x4": 4, "platline-x10": 10 };

export function caseNames(): string[] {
  return [...PLAN_NAMES, ...CHART_NAMES.map((c) => `gtnh-flow-${c}`), ...Object.keys(TILED_CASES)];
}

/** The Java chance is a 32-bit float; the dump holds its shortest decimal (spec 7.1). One home for the rule. */
const f32 = Math.fround;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Parses a dump object (already JSON.parsed) into a `SolveInput`: fround on chance, defaults for optional parts. */
export function parseSolveInput(raw: unknown): SolveInput {
  const o = raw as Record<string, unknown>;
  if (o.mode !== "AUTO") throw new Error(`unsupported mode ${String(o.mode)}`);
  const port = (p: PortIn): PortIn => ({
    amount: p.amount,
    chance: f32(p.chance),
    multiplier: p.multiplier,
    resource: p.resource,
    name: p.name,
    free: p.free,
  });
  const machines = (o.machines as MachineIn[]).map(
    (m): MachineIn => ({
      id: m.id,
      name: m.name,
      durationTicks: m.durationTicks,
      energyPerTick: m.energyPerTick,
      throughputFactor: m.throughputFactor,
      inputs: m.inputs.map(port),
      outputs: m.outputs.map(port),
      countFixed: m.countFixed,
      machineCount: m.machineCount,
      targetOutputRates: { ...(m.targetOutputRates ?? {}) },
      targetInputRates: { ...(m.targetInputRates ?? {}) },
    }),
  );
  return {
    mode: "AUTO",
    choice: (o.choice as SolveInput["choice"]) ?? null,
    machines,
    edges: (o.edges as EdgeIn[]).map((e) => ({ ...e })),
    pools: ((o.pools as PoolIn[]) ?? []).map((p) => ({ ...p, machines: [...p.machines] })),
    drawers: ((o.drawers as DrawerIn[]) ?? []).map((d) => ({
      ...d,
      links: d.links.map((l) => ({ ...l })),
      ...(d.takers ? { takers: d.takers.map((l) => ({ ...l })) } : {}),
    })),
    extentPins: { ...((o.extentPins as Record<Id, number>) ?? {}) },
    spares: JSON.parse(JSON.stringify(o.spares ?? {})) as SolveInput["spares"],
  };
}

/** Java `UUID.nameUUIDFromBytes`. */
export function nameUuidFromBytes(bytes: Uint8Array): string {
  const md5 = createHash("md5").update(bytes).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function uuidLongs(u: Id): [bigint, bigint] {
  const h = u.replace(/-/g, "");
  if (h.length !== 32) throw new Error(`not a UUID: ${u}`);
  return [BigInt.asIntN(64, BigInt("0x" + h.slice(0, 16))), BigInt.asIntN(64, BigInt("0x" + h.slice(16)))];
}

/**
 * Java `UUID.compareTo` order, the order ids have in the mod: most significant long then least, each SIGNED.
 * A plain string sort breaks for ids whose first hex digit is 8..f (spec 4.2 and 7.10).
 */
export function compareId(a: Id, b: Id): number {
  const la = uuidLongs(a);
  const lb = uuidLongs(b);
  if (la[0] !== lb[0]) return la[0] < lb[0] ? -1 : 1;
  if (la[1] !== lb[1]) return la[1] < lb[1] ? -1 : 1;
  return 0;
}

/** The mod's `SolverCorpus.tile`: copy 0 keeps its ids, copy c >= 1 renames every id u to nameUUIDFromBytes("c:u"). */
export function tile(input: SolveInput, copies: number): SolveInput {
  const rename = (c: number, u: Id): Id => (c === 0 ? u : nameUuidFromBytes(Buffer.from(`${c}:${u}`, "utf8")));
  const machines: MachineIn[] = [];
  const edges: EdgeIn[] = [];
  const pools: PoolIn[] = [];
  const drawers: DrawerIn[] = [];
  const extentPins: Record<Id, number> = {};
  const spares: SolveInput["spares"] = {};
  for (let c = 0; c < copies; c++) {
    const r = (u: Id) => rename(c, u);
    for (const m of input.machines) machines.push({ ...m, id: r(m.id) });
    for (const e of input.edges) edges.push({ ...e, id: r(e.id), source: r(e.source), target: r(e.target) });
    for (const p of input.pools) pools.push({ ...p, machines: p.machines.map(r) });
    for (const d of input.drawers)
      drawers.push({
        ...d,
        id: r(d.id),
        links: d.links.map((l) => ({ ...l, node: r(l.node) })),
        ...(d.takers ? { takers: d.takers.map((l) => ({ ...l, node: r(l.node) })) } : {}),
      });
    for (const [k, v] of Object.entries(input.extentPins)) extentPins[r(k)] = v;
    const rekey = (key: string) => (c === 0 ? key : key.replace(UUID_RE, (u) => r(u)));
    for (const [lk, bearers] of Object.entries(input.spares)) {
      const out: Record<string, number> = {};
      for (const [bk, share] of Object.entries(bearers)) out[rekey(bk)] = share;
      spares[rekey(lk)] = out;
    }
  }
  return { mode: "AUTO", choice: null, machines, edges, pools, drawers, extentPins, spares };
}

/** `joined(in, k)`: the k copies of a tiled plan made ONE island by a pool of the first machine of each (speed tests only). */
export function joined(tiled: SolveInput, perCopyMachines: number, copies: number): SolveInput {
  const first: Id[] = [];
  for (let c = 0; c < copies; c++) first.push(tiled.machines[c * perCopyMachines].id);
  return { ...tiled, pools: [...tiled.pools, { machines: first, capacity: 1_000_000, exact: false }] };
}

export function loadInput(name: string): SolveInput {
  const copies = TILED_CASES[name];
  if (copies !== undefined) return tile(loadInput("platline"), copies);
  return parseSolveInput(readJson(path.join(CORPUS_DIR, "inputs", `${name}.json`)));
}

/** A golden digest, as parsed JSON (`{ solution, alternatives }`, spec 6.2). */
export type Digest = { solution: Record<string, unknown>; alternatives: Record<string, unknown> };

export function loadGolden(name: string): Digest {
  return readJson(path.join(CORPUS_DIR, "goldens", `${name}.json`)) as Digest;
}

export function listFiles(dir: "inputs" | "goldens"): string[] {
  return readdirSync(path.join(CORPUS_DIR, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}
