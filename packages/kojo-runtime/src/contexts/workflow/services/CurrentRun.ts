import { Context } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";

/**
 * The run a phase belongs to.
 *
 * Provided by `workflow()` from the engine's execution id, so a phase never has to be told which
 * run it is in and cannot be told the wrong one.
 */
export class CurrentRun extends Context.Service<CurrentRun, { readonly runId: RunId }>()(
  "kojo/workflow/CurrentRun",
) {}
