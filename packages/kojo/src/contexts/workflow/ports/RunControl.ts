import type { Effect } from "effect";

export interface LifecycleOwner {
  readonly daemonInstanceId: string;
  readonly runnerInstanceIds: ReadonlyArray<string>;
  readonly recordedAt: string;
}

export interface DrainProgress {
  readonly held: true;
  readonly executingRunIds: ReadonlyArray<string>;
  readonly observedAt: string;
}

export interface ProjectRunControl {
  readonly holdProjectDispatch: (projectId: string, detail: string) => Effect.Effect<void, Error>;
  readonly drainProject: (projectId: string) => Effect.Effect<void, Error>;
  readonly releaseProjectDispatch: (projectId: string) => void;
}

export interface GateRunControl {
  readonly continueRun: (runId: string) => Effect.Effect<void, Error>;
}

export interface LifecycleRunControl {
  readonly beginDaemonDrain: Effect.Effect<DrainProgress, Error>;
  readonly daemonDrainProgress: Effect.Effect<DrainProgress, Error>;
  readonly forceDaemonDrain: (cleanupMillis: number) => Effect.Effect<LifecycleOwner, Error>;
  readonly releaseDaemonDispatch: Effect.Effect<void, Error>;
  readonly stopForDaemonLifecycle: (
    cleanupMillis: number,
    forced: boolean,
  ) => Effect.Effect<LifecycleOwner, Error>;
  readonly lifecycleOwner: () => LifecycleOwner;
}
