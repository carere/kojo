import { Context, Effect, Layer } from "effect";

export const DELETION_PHASES = [
  "quiescing",
  "clearing-engine",
  "clearing-owned-content",
  "deleting-records",
  "needs-attention",
] as const;

export type DeletionPhase = (typeof DELETION_PHASES)[number];

export interface DeletionHooksShape {
  readonly afterPhase: (phase: DeletionPhase) => Effect.Effect<void>;
}

/**
 * A deliberately narrow lifecycle seam. Production does nothing; process
 * integration tests may stop the Host after a committed phase to prove that
 * the durable intent resumes in order after a crash.
 */
export class DeletionHooks extends Context.Service<DeletionHooks, DeletionHooksShape>()(
  "kojo/host/DeletionHooks",
) {}

export const DeletionHooksLive = Layer.sync(DeletionHooks, () => {
  const crashPhase = process.env.KOJO_TEST_DELETION_CRASH_PHASE;
  return {
    afterPhase: (phase) =>
      Effect.sync(() => {
        if (crashPhase === phase) process.kill(process.pid, "SIGKILL");
      }),
  } satisfies DeletionHooksShape;
});
