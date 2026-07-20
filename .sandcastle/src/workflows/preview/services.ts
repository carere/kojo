import { Context, type Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { ExternalServiceError, ProcessError, WorkflowError } from "../../types/errors";
import type { DockerRunInput } from "../../types/preview";

export type PreviewFailure = ExternalServiceError | ProcessError | WorkflowError;

export type PreviewContainerState =
  | { readonly status: "missing" }
  | { readonly status: "stopped" }
  | {
      readonly status: "running";
      readonly port: number;
      readonly revision: string;
      readonly worktreePath: string;
    };

export interface PreviewDockerService {
  readonly assertReady: () => Effect.Effect<void, PreviewFailure, ChildProcessSpawner>;
  readonly prepareImage: (
    image: string,
    expectedUid: number,
  ) => Effect.Effect<string, PreviewFailure, ChildProcessSpawner>;
  readonly inspect: (
    containerName: string,
  ) => Effect.Effect<PreviewContainerState, PreviewFailure, ChildProcessSpawner>;
  readonly create: (
    input: DockerRunInput,
  ) => Effect.Effect<void, PreviewFailure, ChildProcessSpawner>;
  readonly initialize: (
    containerName: string,
    branch: string,
  ) => Effect.Effect<number, PreviewFailure, ChildProcessSpawner>;
  readonly remove: (
    containerName: string,
  ) => Effect.Effect<void, PreviewFailure, ChildProcessSpawner>;
  readonly readLogs: (
    containerName: string,
  ) => Effect.Effect<string, PreviewFailure, ChildProcessSpawner>;
}

export class PreviewDocker extends Context.Service<PreviewDocker, PreviewDockerService>()(
  "sandcastle/preview/PreviewDocker",
) {}

export class PreviewReadiness extends Context.Service<
  PreviewReadiness,
  {
    readonly wait: (url: string) => Effect.Effect<void, PreviewFailure>;
  }
>()("sandcastle/preview/PreviewReadiness") {}
