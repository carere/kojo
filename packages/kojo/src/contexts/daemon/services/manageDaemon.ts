import { Effect } from "effect";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonStatus } from "../models/DaemonStatus.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { ManagedInstallationRepository } from "../ports/ManagedInstallationRepository.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { inspectDaemon } from "./daemonStatus.ts";

export interface DaemonLifecycle {
  readonly install: Effect.Effect<
    { readonly changed: boolean; readonly status: DaemonStatus },
    LifecycleError
  >;
  readonly start: Effect.Effect<DaemonStatus, LifecycleError>;
  readonly stop: Effect.Effect<DaemonStatus, LifecycleError>;
  readonly enable: Effect.Effect<DaemonStatus, LifecycleError>;
  readonly disable: (stopNow: boolean) => Effect.Effect<DaemonStatus, LifecycleError>;
  readonly keepRunningAfterLogout: Effect.Effect<DaemonStatus, LifecycleError>;
  readonly status: Effect.Effect<DaemonStatus, LifecycleError>;
}

const lifecycleError = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "LIFECYCLE_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

export const manageDaemon = (
  paths: DaemonPaths,
  nativeService: NativeService,
  installation: ManagedInstallationRepository,
  installOptions: { readonly sourceRoot?: string; readonly bunExecutable?: string } = {},
): DaemonLifecycle => {
  const status = inspectDaemon(paths, nativeService, installation);
  const nativeAction = (action: () => void): Effect.Effect<void, LifecycleError> =>
    Effect.try({ try: action, catch: lifecycleError });
  const transition = (action: () => void): Effect.Effect<DaemonStatus, LifecycleError> =>
    nativeAction(action).pipe(Effect.flatMap(() => status));
  return {
    install: Effect.gen(function* () {
      yield* nativeAction(nativeService.assertSupported);
      const installed = yield* installation.install({
        ...installOptions,
        paths,
        serviceDocument: nativeService.serviceDocument,
      });
      if (installed.outcome === "installed") {
        yield* nativeAction(() => nativeService.installAndStart(paths.serviceDefinition));
      }
      return { changed: installed.outcome === "installed", status: yield* status };
    }),
    start: transition(() => nativeService.start(paths.serviceDefinition)),
    stop: transition(nativeService.stop),
    enable: transition(nativeService.enable),
    disable: (stopNow) => transition(() => nativeService.disable(stopNow)),
    keepRunningAfterLogout: transition(nativeService.keepRunningAfterLogout),
    status,
  };
};
