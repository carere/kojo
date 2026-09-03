import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { NativeService } from "../ports/NativeService.ts";
import {
  type RunningDaemon as ComposedRunningDaemon,
  type StartDaemonOptions as CompositionOptions,
  startDaemonComposition,
} from "../services/DaemonComposition.ts";
import { recoverPurgeSafety as recoverPurgeSafetyUseCase } from "./recoverPurgeSafety.ts";

export type RunningDaemon = ComposedRunningDaemon;
export type StartDaemonOptions = CompositionOptions;

/** Host adapter entry point for the Daemon composition. */
export const startDaemon = (paths: DaemonPaths, options: StartDaemonOptions = {}): RunningDaemon =>
  startDaemonComposition(paths, options);

/** Restricted sole-owner purge recovery entry point. */
export const recoverPurgeSafety = (
  paths: DaemonPaths,
  operationId: string,
  planToken: string,
  capability: string,
  nativeService: NativeService,
  now: () => number = Date.now,
): Promise<void> =>
  recoverPurgeSafetyUseCase(paths, operationId, planToken, capability, nativeService, now);
