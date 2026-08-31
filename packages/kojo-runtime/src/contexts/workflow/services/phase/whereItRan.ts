import { Effect, Option } from "effect";
import { Sandbox } from "../../../sandbox/ports/Sandbox.ts";
import { laneOf, type SandboxId } from "../../../shared/models/SandboxId.ts";

/**
 * The acquisition a phase is running inside, or nothing when it is running on the host.
 *
 * `Effect.serviceOption` rather than `yield* Sandbox`, and the difference is the whole design of the
 * sandbox scope: `Sandbox` is present only inside `sandboxed`, so a phase that asked for it outright
 * would demand a container in its requirements — every code phase, every routing agent, whether or
 * not it needs one. Asking optionally records where the phase ran without changing what a phase is.
 *
 * The answer is the **acquisition**, not the scope. A phase that ran before a gate and its twin
 * after the rebuild name different sandboxes, because they ran in different containers.
 */
export const whereItRan: Effect.Effect<SandboxId | undefined> = Effect.map(
  Effect.serviceOption(Sandbox),
  (sandbox) => Option.getOrUndefined(Option.map(sandbox, (handle) => handle.id)),
);

/**
 * The **lane** the current point of the workflow is in: the enclosing sandbox scope's own name, or
 * nothing on the host.
 *
 * The same reading as {@link whereItRan}, one level less specific and stable where that one is not.
 * An acquisition id changes every time the container is rebuilt; the scope's name does not change
 * for the life of the run. So this is what may be built into anything that has to mean the same
 * thing before and after a suspension — a durable deferred's name, above all.
 */
export const currentLane: Effect.Effect<Option.Option<string>> = Effect.map(
  Effect.serviceOption(Sandbox),
  (sandbox) => Option.flatMap(sandbox, (handle) => laneOf(handle.id)),
);
