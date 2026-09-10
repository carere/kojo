import { decodeRunProgress } from "@carere/kojo-client-contracts/contexts/client/contracts/progress";
import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { PhaseResult } from "../models/DaemonRun.ts";

export const progressDescription = "__kojo_run_progress__";

/** Keep each item's highest authored revision, independent of sibling completion order. */
export const runProgress = (
  phases: ReadonlyArray<PhaseResult>,
): NonNullable<RunDocument["progress"]> => {
  const items = new Map<string, NonNullable<RunDocument["progress"]>[number]>();
  for (const phase of phases) {
    if (phase.description !== progressDescription || phase.outcome !== "succeeded") continue;
    const result = phase.encodedResult as {
      readonly _tag?: unknown;
      readonly exit?: { readonly _tag?: unknown; readonly value?: unknown };
    } | null;
    if (result?._tag !== "Complete" || result.exit?._tag !== "Success") continue;
    for (const item of decodeRunProgress(result.exit.value) ?? []) {
      const current = items.get(item.key);
      if (current === undefined || item.revision > current.revision)
        items.set(item.key, { ...item, observedAt: phase.endedAt });
    }
  }
  return [...items.values()].sort((left, right) => left.key.localeCompare(right.key));
};
