import type { CollabStore } from "./collab-store.js";
import type { DuelStore } from "./duel-store.js";

export interface DuelRecoveryResult {
  interruptedIds: string[];
  closedIds: string[];
}

/**
 * Startup reconciliation for duels that were still "running" when the previous runtime stopped.
 * Marks each as failed and idempotently closes its collaboration conversation (a duel's id is its
 * collaboration conversation id), so a crash-interrupted duel stops holding an open workroom slot
 * against the collaboration limit. Closing is idempotent — a conversation already closed or gone
 * is a no-op, and one conversation's failure never blocks reconciling the rest.
 */
export async function reconcileInterruptedDuels(
  duelStore: Pick<DuelStore, "interruptRunning">,
  collabStore: Pick<CollabStore, "close">,
  onError?: (id: string, error: unknown) => void
): Promise<DuelRecoveryResult> {
  const interruptedIds = await duelStore.interruptRunning();
  const closedIds: string[] = [];
  for (const id of interruptedIds) {
    try {
      const closed = await collabStore.close(id, "devbot");
      if (closed) {
        closedIds.push(id);
      }
    } catch (error) {
      onError?.(id, error);
    }
  }
  return { interruptedIds, closedIds };
}
