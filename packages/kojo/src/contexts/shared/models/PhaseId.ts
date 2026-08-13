import { Schema } from "effect";

/** Identifies one phase of one run. Branded so it cannot be mixed with a run or sandbox id. */
export const PhaseId = Schema.String.pipe(Schema.brand("PhaseId"));

export type PhaseId = typeof PhaseId.Type;

/**
 * Builds a phase id from parts the engine controls — the run, the phase name, and the attempt.
 *
 * A cast rather than a decode, deliberately: these three values are ours, so decoding them would
 * be a runtime check of something that cannot be wrong. Ids arriving from outside — a CLI
 * argument, a database row, an HTTP path — must be decoded through `PhaseId` instead.
 */
export const makePhaseId = (runId: string, name: string, attempt: number): PhaseId =>
  `${runId}/${name}/${attempt}` as PhaseId;
