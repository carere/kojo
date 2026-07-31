import type { ProjectSnapshot } from "@kojo/control";

export type NoFollowUnlinkResult = "removed" | "missing" | "unsafe";

export interface DisposableFileUnlinker {
  readonly unlinkRegularFile: (
    project: ProjectSnapshot,
    path: string,
    beforeUnlink?: (path: string) => Promise<void>,
  ) => Promise<NoFollowUnlinkResult>;
}
