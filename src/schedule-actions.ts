import type { ScheduleEntry, ScheduleStore, StandingApproval, StandingApprovalRefusal } from "./schedule-store.js";
import type { TaskStore } from "./task-store.js";
import { publicErrorMessage } from "./security.js";

export type ActionOccurrenceOutcome =
  | { kind: "executed"; approval: StandingApproval }
  | { kind: "proposed"; taskId: string; reason: StandingApprovalRefusal | "safe-mode" }
  | { kind: "skipped"; note: string }
  | { kind: "failed"; note: string };

export interface ActionOccurrenceDeps {
  scheduleStore: ScheduleStore;
  taskStore: TaskStore;
  safeMode: boolean;
  createProposal: (entry: ScheduleEntry) => Promise<{ id: string }>;
  executeStandingRun: (entry: ScheduleEntry, approval: StandingApproval) => Promise<string>;
  now?: () => Date;
}

/**
 * Resolves one claimed `action` occurrence under the explicit-approval contract:
 *
 * - A valid, unexpired standing approval is consumed atomically (budget decremented
 *   before any side effect) and only then does the occurrence execute.
 * - Every other state, including safe mode, a missing/expired/exhausted/revoked
 *   standing approval, or one past its review checkpoint, falls back to creating an
 *   approval-gated proposal card. The occurrence never executes writes on its own.
 * - Each occurrence yields at most one proposal: the occurrence is durably linked to
 *   its proposal task, and while that proposal is still awaiting a decision, later
 *   occurrences skip instead of stacking more cards.
 */
export async function runActionOccurrence(entry: ScheduleEntry, deps: ActionOccurrenceDeps): Promise<ActionOccurrenceOutcome> {
  const now = deps.now ?? (() => new Date());
  let refusal: StandingApprovalRefusal | "safe-mode";
  if (deps.safeMode) {
    // Never consume budget or execute while safe mode is active; the fallback card can
    // only be approved once safe mode is lifted, because approval is safe-mode gated too.
    refusal = "safe-mode";
  } else {
    const decision = await deps.scheduleStore.consumeStandingApproval(entry.id, now());
    if (decision.ok) {
      try {
        const summary = await deps.executeStandingRun(entry, decision.approval);
        await deps.scheduleStore.markRun(
          entry.id,
          `Standing-approval run ${decision.approval.runsUsed}/${decision.approval.maxRuns}: ${summary}`,
          now()
        );
        return { kind: "executed", approval: decision.approval };
      } catch (error) {
        const note = `Failed: ${publicErrorMessage(error)}`;
        await deps.scheduleStore.markRun(entry.id, note, now());
        return { kind: "failed", note };
      }
    }
    refusal = decision.reason;
  }

  if (entry.lastProposalTaskId) {
    const previous = await deps.taskStore.get(entry.lastProposalTaskId);
    if (previous?.status === "awaiting-approval") {
      const note = `Skipped: proposal \`${previous.id}\` from a previous occurrence is still awaiting approval.`;
      await deps.scheduleStore.markRun(entry.id, note, now());
      return { kind: "skipped", note };
    }
  }

  try {
    const proposal = await deps.createProposal(entry);
    await deps.scheduleStore.markProposed(entry.id, proposal.id, proposalNote(refusal, proposal.id), now());
    return { kind: "proposed", taskId: proposal.id, reason: refusal };
  } catch (error) {
    const note = `Failed: ${publicErrorMessage(error)}`;
    await deps.scheduleStore.markRun(entry.id, note, now());
    return { kind: "failed", note };
  }
}

function proposalNote(reason: StandingApprovalRefusal | "safe-mode", taskId: string): string {
  const causes: Record<StandingApprovalRefusal | "safe-mode", string> = {
    none: "no standing approval",
    revoked: "the standing approval was revoked",
    expired: "the standing approval expired",
    exhausted: "the standing approval's run budget is exhausted",
    "review-due": "the standing approval reached its review checkpoint",
    "safe-mode": "safe mode is active"
  };
  return `Posted approval card \`${taskId}\` (${causes[reason]}).`;
}
