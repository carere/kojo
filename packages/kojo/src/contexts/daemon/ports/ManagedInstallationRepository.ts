import type { Effect } from "effect";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type { CheckedManagedReleaseManifest } from "../models/ManagedRelease.ts";

export interface InstallManagedReleaseRequest {
  readonly paths: DaemonPaths;
  readonly serviceDocument: (paths: DaemonPaths) => string;
  readonly sourceRoot?: string;
  readonly bunExecutable?: string;
}

export interface ManagedInstallationRepository {
  readonly install: (
    request: InstallManagedReleaseRequest,
  ) => Effect.Effect<
    { readonly outcome: "installed" | "kept"; readonly releaseId: string },
    LifecycleError
  >;
  readonly isPresent: (paths: DaemonPaths) => boolean;
  readonly checkedRelease: (paths: DaemonPaths, releaseId: string) => CheckedManagedReleaseManifest;
}
