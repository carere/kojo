import { Schema } from "effect";
import { PhaseId } from "../../shared/models/PhaseId.ts";
import { SandboxId } from "../../shared/models/SandboxId.ts";
import { PhaseKind } from "./PhaseRecord.ts";

const InFlightPhaseBase: Schema.Class<
  InFlightPhase,
  Schema.Struct<{
    readonly phaseId: Schema.brand<Schema.String, "PhaseId">;
    readonly name: Schema.String;
    readonly kind: Schema.Literals<readonly ["actor", "code", "agent"]>;
    readonly attempt: Schema.Finite;
    readonly startedAt: Schema.Finite;
    readonly sandboxId: Schema.optionalKey<Schema.brand<Schema.String, "SandboxId">>;
  }>,
  Record<never, never>
> = Schema.Class<InFlightPhase>("InFlightPhase")({
  phaseId: PhaseId,
  name: Schema.String,
  kind: PhaseKind,
  /** Which attempt this is. A retried phase re-enters, so the number moves while the name does not. */
  attempt: Schema.Finite,
  startedAt: Schema.Finite,
  /** The acquisition it is running inside, absent on the host — the same reading `PhaseRecord` takes. */
  sandboxId: Schema.optionalKey(SandboxId),
});

/**
 * One executing Phase attempt. A Run can have several active observations.
 * Completed Phase records remain separate and are written on exit. The Daemon
 * retains entries by Claim generation and excludes completed or stale attempts.
 * An observation does not establish execution authority or a safe retry.
 */
export class InFlightPhase extends InFlightPhaseBase {}
