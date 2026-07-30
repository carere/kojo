import type { WorkflowScheduleDefinition } from "@kojo/control";
import { Cron, Result } from "effect";

/**
 * Effect Cron remains an implementation detail of the Host. This function
 * deliberately deals only in the stable definition fields and UTC epoch
 * milliseconds used by the durable Project Store.
 */
export const nextWorkflowScheduleOccurrence = (
  definition: WorkflowScheduleDefinition,
  strictlyAfterMs: number,
) => {
  const parsed = Cron.parse(definition.cron, definition.timeZone);
  if (Result.isFailure(parsed)) throw new Error("Accepted Workflow Schedule cron is invalid");
  let candidate = Cron.next(parsed.success, new Date(Math.max(0, strictlyAfterMs)));
  // Effect Cron can return the post-jump wall-clock instant for a nonexistent
  // spring-forward time. Re-checking its own matcher keeps Kojo's documented
  // policy: nonexistent local times are skipped, while the first fall-back
  // match remains the only occurrence.
  for (let attempt = 0; !Cron.match(parsed.success, candidate) && attempt < 8; attempt += 1) {
    candidate = Cron.next(parsed.success, candidate);
  }
  if (!Cron.match(parsed.success, candidate)) {
    throw new Error("Workflow Schedule cron could not find a valid occurrence");
  }
  return candidate.getTime();
};
