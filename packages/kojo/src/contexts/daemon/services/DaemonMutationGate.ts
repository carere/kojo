import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";

/** Holds new ordinary mutations and waits for already accepted handlers to finish. */
export class DaemonMutationGate {
  #holder: string | undefined;
  #active = 0;
  readonly #settled = new Set<() => void>();

  constructor(retainedHolder?: string) {
    this.#holder = retainedHolder;
  }

  readonly enter = (): (() => void) | undefined => {
    if (this.#holder !== undefined) return undefined;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      if (this.#active === 0) {
        for (const settle of this.#settled) settle();
        this.#settled.clear();
      }
    };
  };

  readonly hold = (operationId: string): Effect.Effect<void, LifecycleError> =>
    Effect.tryPromise({
      try: async () => {
        if (this.#holder !== undefined && this.#holder !== operationId) {
          throw new LifecycleError(
            "DAEMON_MUTATIONS_HELD",
            `ordinary mutations are held by lifecycle operation ${this.#holder}`,
          );
        }
        this.#holder = operationId;
        if (this.#active === 0) return;
        await new Promise<void>((resolve) => this.#settled.add(resolve));
      },
      catch: (cause) =>
        cause instanceof LifecycleError
          ? cause
          : new LifecycleError(
              "DAEMON_MUTATION_HOLD_FAILED",
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
    });

  readonly release = (operationId: string): Effect.Effect<void, LifecycleError> =>
    Effect.try({
      try: () => {
        if (this.#holder === undefined) return;
        if (this.#holder !== operationId) {
          throw new LifecycleError(
            "DAEMON_MUTATION_HOLD_MISMATCH",
            `ordinary mutations are held by lifecycle operation ${this.#holder}`,
          );
        }
        this.#holder = undefined;
      },
      catch: (cause) =>
        cause instanceof LifecycleError
          ? cause
          : new LifecycleError(
              "DAEMON_MUTATION_HOLD_FAILED",
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
    });

  readonly heldBy = (): string | undefined => this.#holder;
}
