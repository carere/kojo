import { Context } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";

interface CurrentRunService {
  readonly runId: RunId;
}

const CurrentRunBase: Context.ServiceClass<
  CurrentRun,
  "kojo/workflow/CurrentRun",
  CurrentRunService
> = Context.Service<CurrentRun, CurrentRunService>()("kojo/workflow/CurrentRun");

/**
 * The run a phase belongs to.
 *
 * Provided by `workflow()` from the engine's execution id, so a phase never has to be told which
 * run it is in and cannot be told the wrong one.
 */
export class CurrentRun extends CurrentRunBase {}
