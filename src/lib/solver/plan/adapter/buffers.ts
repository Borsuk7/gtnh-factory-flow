import { getStorageRoles } from "../../../model/storage-role";
import type { FactoryEdge, FactoryProject, FactoryStorage } from "../../../model/types";

export interface BufferFreeGraph {
  edges: FactoryEdge[];
  storages: FactoryStorage[];
  /**
   * For each edge of `edges`, the ids of the project's own edges it stands
   * for (itself unless a buffer was joined away). A joined wire's flow is the
   * flow of every wire it covers.
   */
  covers: Map<string, string[]>;
  /** Buffers removed (a ratio buffer's shares are gone with it). */
  removed: string[];
}

/**
 * Whether a buffer drawer (fed and drawn from) stays a buffer in plan mode (`docs/buffer-drawers.md`): every wire on
 * it runs to a card, none to another drawer. The solver then takes it as a BUFFER drawer. Any other buffer is joined
 * into the wires it stands for.
 */
export function keepsBuffer(storageId: string, edges: readonly FactoryEdge[], storageIds: ReadonlySet<string>): boolean {
  for (const edge of edges) {
    if (edge.source !== storageId && edge.target !== storageId) continue;
    const other = edge.source === storageId ? edge.target : edge.source;
    if (other === storageId || storageIds.has(other)) return false;
  }
  return true;
}

/**
 * A buffer drawer the solver cannot take as one (see `keepsBuffer`) is a junction: every wire into it is joined to
 * every wire out of it, one buffer at a time (a chain still joins its ends). The same rule as the conversion of a Build
 * plan (`convert.ts`), but remembering which of the player's wires each joined wire stands for, so their flows can be
 * shown.
 */
export function expandBuffers(project: FactoryProject): BufferFreeGraph {
  const storages = project.storages ?? [];
  const covers = new Map<string, string[]>(project.edges.map((edge) => [edge.id, [edge.id]]));
  const removed: string[] = [];
  const roles = getStorageRoles({ ...project, poolMode: undefined });
  const storageIds = new Set(storages.map((storage) => storage.id));
  const joins = storages.filter(
    (storage) => roles.get(storage.id) === "buffer" && !keepsBuffer(storage.id, project.edges, storageIds),
  );
  if (joins.length === 0) {
    return { edges: project.edges, storages, covers, removed };
  }

  let edges = project.edges;
  const gone = new Set<string>();
  for (const storage of joins) {
    const feeders = edges.filter((e) => e.target === storage.id && e.source !== storage.id);
    const takers = edges.filter((e) => e.source === storage.id && e.target !== storage.id);
    edges = edges.filter((e) => e.source !== storage.id && e.target !== storage.id);
    for (const feeder of feeders) {
      for (const taker of takers) {
        const id = `${feeder.id}>${taker.id}`;
        const joined: FactoryEdge = {
          id,
          source: feeder.source,
          target: taker.target,
          sourceHandle: feeder.sourceHandle,
          targetHandle: taker.targetHandle,
          resourceKind: feeder.resourceKind,
          resourceId: feeder.resourceId,
        };
        covers.set(id, [...new Set([...(covers.get(feeder.id) ?? []), ...(covers.get(taker.id) ?? [])])]);
        edges.push(joined);
      }
    }
    gone.add(storage.id);
    removed.push(storage.id);
  }
  return { edges, storages: storages.filter((storage) => !gone.has(storage.id)), covers, removed };
}
