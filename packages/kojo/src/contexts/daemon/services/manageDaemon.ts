import {
  installManagedRelease,
  type ManagedInstallationOptions,
} from "../adapters/ManagedInstallation.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonStatus } from "../models/DaemonStatus.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { inspectDaemon } from "./daemonStatus.ts";

export interface DaemonLifecycle {
  readonly install: () => Promise<{ readonly changed: boolean; readonly status: DaemonStatus }>;
  readonly start: () => Promise<DaemonStatus>;
  readonly stop: () => Promise<DaemonStatus>;
  readonly enable: () => Promise<DaemonStatus>;
  readonly disable: (stopNow: boolean) => Promise<DaemonStatus>;
  readonly keepRunningAfterLogout: () => Promise<DaemonStatus>;
  readonly status: () => Promise<DaemonStatus>;
}

export const manageDaemon = (
  paths: DaemonPaths,
  nativeService: NativeService,
  installation: Omit<ManagedInstallationOptions, "paths" | "serviceDocument"> = {},
): DaemonLifecycle => {
  const status = (): Promise<DaemonStatus> => inspectDaemon(paths, nativeService);
  return {
    install: async () => {
      nativeService.assertSupported();
      const installed = await installManagedRelease({
        ...installation,
        paths,
        serviceDocument: nativeService.serviceDocument,
      });
      if (installed.outcome === "installed") nativeService.installAndStart(paths.serviceDefinition);
      return { changed: installed.outcome === "installed", status: await status() };
    },
    start: async () => {
      nativeService.start(paths.serviceDefinition);
      return status();
    },
    stop: async () => {
      nativeService.stop();
      return status();
    },
    enable: async () => {
      nativeService.enable();
      return status();
    },
    disable: async (stopNow) => {
      nativeService.disable(stopNow);
      return status();
    },
    keepRunningAfterLogout: async () => {
      nativeService.keepRunningAfterLogout();
      return status();
    },
    status,
  };
};
