import type { TraceMutation } from "@carere/kojo-runner-contracts/contexts/project/contracts/trace";
import type { Effect } from "effect";
import type { RunAuthority } from "../../workflow/models/DaemonRun.ts";
import type { RunStoreError } from "../../workflow/models/RunStoreError.ts";
import type { TraceProjection } from "../models/DaemonTrace.ts";

export interface TraceRepository {
  readonly write: (
    authority: RunAuthority,
    mutation: TraceMutation,
  ) => Effect.Effect<void, RunStoreError>;
  readonly projection: (runId: string) => Effect.Effect<TraceProjection, RunStoreError>;
}
