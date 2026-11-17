import type { BoardClipboardPayload } from "@/store/factory-store";
import { randomUUID } from "@/lib/random-id";

export interface DeviceBlueprint {
  id: string;
  name: string;
  payload: BoardClipboardPayload;
}

async function access<T>(
  mode: IDBTransactionMode,
  operation: (shelf: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("gtnh-planner-blueprints", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("shelf", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("shelf", mode);
      const request = operation(transaction.objectStore("shelf"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function listDeviceBlueprints(): Promise<DeviceBlueprint[]> {
  return access("readonly", (shelf) => shelf.getAll());
}

export async function saveDeviceBlueprint(name: string, payload: BoardClipboardPayload): Promise<void> {
  await access("readwrite", (shelf) => shelf.add({ id: randomUUID(), name, payload }));
}

export async function removeDeviceBlueprint(id: string): Promise<void> {
  await access("readwrite", (shelf) => shelf.delete(id));
}
