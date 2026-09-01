import { Data, Deferred, Effect } from "effect";

export class ProjectRunnerError extends Data.TaggedError("ProjectRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProjectRunnerHandle {
  readonly instanceId: string;
  readonly packageGraphId: string;
  readonly purpose: "execution" | "trigger";
  /** Completes only after the owned process has stopped. */
  readonly stop: Effect.Effect<void, ProjectRunnerError>;
}

interface ProjectState {
  readonly handle?: ProjectRunnerHandle;
  readonly turn: Deferred.Deferred<void>;
}

/** Owns the only Project Runner process and serializes graph-switch preparation per Project. */
export class ProjectRunnerSupervisor {
  readonly #projects = new Map<string, ProjectState>();

  currentGraph(projectId: string): string | undefined {
    return this.#projects.get(projectId)?.handle?.packageGraphId;
  }

  prepare<A, StopError, LoadError>(options: {
    readonly projectId: string;
    readonly packageGraphId: string;
    readonly stopCurrentPolling: Effect.Effect<void, StopError>;
    readonly load: Effect.Effect<A, LoadError>;
  }): Effect.Effect<A, ProjectRunnerError | StopError | LoadError> {
    const supervisor = this;
    return Effect.gen(function* () {
      const prior = supervisor.#projects.get(options.projectId);
      const turn = yield* Deferred.make<void>();
      supervisor.#projects.set(options.projectId, {
        ...(prior?.handle === undefined ? {} : { handle: prior.handle }),
        turn,
      });
      const runTurn = Effect.gen(function* () {
        if (prior !== undefined) yield* Deferred.await(prior.turn);
        yield* options.stopCurrentPolling;
        const current = supervisor.#projects.get(options.projectId)?.handle;
        if (current !== undefined && current.packageGraphId !== options.packageGraphId) {
          yield* current.stop;
          const selected = supervisor.#projects.get(options.projectId);
          if (selected?.handle?.instanceId === current.instanceId) {
            supervisor.#projects.set(options.projectId, { turn });
          }
        }
        return yield* options.load;
      });
      return yield* runTurn.pipe(Effect.ensuring(Deferred.succeed(turn, undefined)));
    });
  }

  attach(projectId: string, handle: ProjectRunnerHandle): Effect.Effect<void, ProjectRunnerError> {
    const supervisor = this;
    return Effect.gen(function* () {
      let state = supervisor.#projects.get(projectId);
      if (state === undefined) {
        const turn = yield* Deferred.make<void>();
        yield* Deferred.succeed(turn, undefined);
        state = { turn };
      }
      const current = state.handle;
      if (current !== undefined && current.instanceId !== handle.instanceId) yield* current.stop;
      supervisor.#projects.set(projectId, { handle, turn: state.turn });
    });
  }

  detach(projectId: string, instanceId: string): void {
    const state = this.#projects.get(projectId);
    if (state?.handle?.instanceId !== instanceId) return;
    this.#projects.set(projectId, { turn: state.turn });
  }

  stop(projectId: string): Effect.Effect<void, ProjectRunnerError> {
    const supervisor = this;
    return Effect.gen(function* () {
      const state = supervisor.#projects.get(projectId);
      if (state?.handle === undefined) return;
      yield* state.handle.stop;
      supervisor.detach(projectId, state.handle.instanceId);
    });
  }

  shutdown(): Effect.Effect<void> {
    return Effect.forEach(
      [...this.#projects.entries()],
      ([projectId, state]) =>
        (state.handle?.stop ?? Effect.void).pipe(
          Effect.ensuring(
            Effect.sync(() => this.detach(projectId, state.handle?.instanceId ?? "")),
          ),
          Effect.ignore,
        ),
      { concurrency: "unbounded", discard: true },
    );
  }
}
